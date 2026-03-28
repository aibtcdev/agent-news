import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getLatestBrief, getBriefByDate, listBriefDates, recordEarning, reconcilePaymentStage, stagePayment } from "../lib/do-client";
import { BRIEF_PRICE_SATS, CORRESPONDENT_SHARE } from "../lib/constants";
import { getUTCDate } from "../lib/helpers";
import { logPaymentEvent } from "../lib/payment-logging";
import { validateDateFormat } from "../lib/validators";
import { buildLocalPaymentStatusUrl, buildPaymentRequired, verifyPayment, mapVerificationError } from "../services/x402";

const briefRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/brief — get today's compiled brief, or today's date with empty content if not yet compiled.
// Always returns today's UTC date so the frontend can show today's signal feed before the
// brief is compiled, rather than falling back to yesterday's stale brief.
briefRouter.get("/api/brief", async (c) => {
  const format = c.req.query("format") ?? "json";
  const today = getUTCDate();
  const [brief, archive] = await Promise.all([
    getLatestBrief(c.env),
    listBriefDates(c.env),
  ]);

  // Only use the brief if it was compiled today — if it's from a previous day, treat it as
  // absent so the frontend shows today's date and falls through to renderSignalFeed().
  const todaysBrief = brief?.date === today ? brief : null;

  if (!todaysBrief) {
    if (format === "text") {
      return new Response("", {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    }
    return c.json({
      date: today,
      compiledAt: null,
      latest: true,
      archive,
      inscription: null,
    });
  }

  if (format === "text") {
    return new Response(todaysBrief.text, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  }

  const jsonData = todaysBrief.json_data ? (JSON.parse(todaysBrief.json_data) as Record<string, unknown>) : {};

  // Build inscription object matching frontend expectations
  const inscription = todaysBrief.inscription_id
    ? { inscriptionId: todaysBrief.inscription_id, inscribedTxid: todaysBrief.inscribed_txid }
    : (jsonData.inscription ?? null);

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({
    preview: false,
    date: todaysBrief.date,
    compiledAt: todaysBrief.compiled_at,
    latest: true,
    archive,
    inscription,
    price: { amount: BRIEF_PRICE_SATS, asset: "sBTC (sats)", protocol: "x402" },
    ...jsonData,
    text: todaysBrief.text,
  });
});

// GET /api/brief/:date — get a specific brief by date (with optional x402 paywall)
briefRouter.get("/api/brief/:date", async (c) => {
  const date = c.req.param("date");

  // Validate date format YYYY-MM-DD
  if (!validateDateFormat(date)) {
    return c.json(
      { error: "Invalid date format", hint: "Use YYYY-MM-DD" },
      400
    );
  }

  const brief = await getBriefByDate(c.env, date);

  if (!brief) {
    return c.json({ error: `No brief found for ${date}` }, 404);
  }

  // x402 paywall for past briefs (when not free)
  const briefsFree = c.env.BRIEFS_FREE !== "false";
  if (!briefsFree) {
    const logger = c.get("logger");
    const paymentHeader =
      c.req.header("X-PAYMENT") ?? c.req.header("payment-signature");

    if (!paymentHeader) {
      logPaymentEvent(logger, "info", "payment.required", {
        route: "/api/brief/:date",
        action: "return_402_payment_required",
      });
      return buildPaymentRequired({
        amount: BRIEF_PRICE_SATS,
        description: `Access to aibtc.news daily brief for ${date}`,
      });
    }

    const verification = await verifyPayment(paymentHeader, BRIEF_PRICE_SATS, c.env, {
      logger,
      route: "/api/brief/:date",
    });
    if (!verification.valid) {
      const { body, status, headers } = mapVerificationError(verification);
      logPaymentEvent(logger, status === 503 ? "error" : "warn", "payment.retry_decision", {
        route: "/api/brief/:date",
        paymentId: verification.paymentId,
        status: verification.paymentState ?? null,
        terminalReason: verification.terminalReason ?? null,
        action: status === 409
          ? "retry_after_nonce_recovery"
          : status === 503
            ? "retry_after_relay_recovery"
            : body.retryable
              ? "repay_or_resubmit"
              : "stop_retry",
      });
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          c.header(key, value);
        }
      }
      return c.json(body, status);
    }

    const correspondentShare = Math.floor(BRIEF_PRICE_SATS * CORRESPONDENT_SHARE);
    logPaymentEvent(logger, "info", "payment.accepted", {
      route: "/api/brief/:date",
      paymentId: verification.paymentId,
      status: verification.paymentState ?? "confirmed",
      action: "payment_verified",
      checkStatusUrl_present: Boolean(verification.checkStatusUrl),
    });
    if (verification.paymentStatus === "pending" && !verification.paymentId) {
      logger.error("pending brief verification missing paymentId", { date });
      return c.json(
        { error: "Relay accepted payment but did not provide a paymentId for pending brief access" },
        503
      );
    }
    if (verification.paymentState === "confirmed" && !verification.paymentId) {
      if (verification.payer) {
        await recordEarning(c.env, {
          btc_address: verification.payer,
          amount_sats: correspondentShare,
          reason: "brief-revenue",
          reference_id: verification.txid ?? null,
        });
      }
      logPaymentEvent(logger, "info", "payment.delivery_confirmed", {
        route: "/api/brief/:date",
        paymentId: null,
        status: "confirmed",
        action: "brief_access_confirmed_http_fallback",
        compat_shim_used: true,
      });
    }
    if (verification.paymentId) {
      const stageResult = await stagePayment(c.env, {
        paymentId: verification.paymentId,
        payload: {
          kind: "brief_access",
          date,
          payer: verification.payer ?? null,
          amount_sats: correspondentShare,
        },
      });
      if (!stageResult.ok) {
        return c.json({ error: stageResult.error ?? "Failed to stage brief access" }, stageResult.status ?? 500);
      }
      logPaymentEvent(logger, "info", "payment.delivery_staged", {
        route: "/api/brief/:date",
        paymentId: verification.paymentId,
        status: verification.paymentState ?? "queued",
        action: verification.paymentStatus === "pending"
          ? "return_202_pending_with_legacy_headers"
          : "stage_brief_access",
        checkStatusUrl_present: Boolean(verification.checkStatusUrl),
        compat_shim_used: verification.paymentStatus === "pending",
      });
    }

    if (verification.paymentState === "confirmed" && verification.paymentId) {
      await reconcilePaymentStage(c.env, verification.paymentId, {
        status: "confirmed",
        txid: verification.txid,
      });
      logPaymentEvent(logger, "info", "payment.delivery_confirmed", {
        route: "/api/brief/:date",
        paymentId: verification.paymentId,
        status: "confirmed",
        action: "brief_access_finalized",
      });
    }

    if (verification.paymentStatus === "pending" && verification.paymentId) {
      const checkStatusUrl = verification.checkStatusUrl ?? buildLocalPaymentStatusUrl(new URL(c.req.url).origin, verification.paymentId);
      c.header("X-Payment-Status", "pending");
      c.header("X-Payment-Id", verification.paymentId);
      return c.json(
        {
          paymentId: verification.paymentId,
          paymentStatus: "pending",
          status: verification.paymentState ?? "queued",
          checkStatusUrl,
          message: "Brief access is staged until the payment is confirmed.",
        },
        202
      );
    }
  }

  const format = c.req.query("format") ?? "json";

  if (format === "text") {
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.body(brief.text);
  }

  const jsonData = brief.json_data ? (JSON.parse(brief.json_data) as Record<string, unknown>) : {};

  const inscription = brief.inscription_id
    ? { inscriptionId: brief.inscription_id, inscribedTxid: brief.inscribed_txid }
    : (jsonData.inscription ?? null);

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({
    date: brief.date,
    compiledAt: brief.compiled_at,
    inscription,
    ...jsonData,
    text: brief.text,
  });
});

export { briefRouter };
