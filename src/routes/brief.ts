import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getLatestBrief, getBriefByDate, recordEarning } from "../lib/do-client";
import { BRIEFS_FREE, BRIEF_PRICE_SATS, CORRESPONDENT_SHARE } from "../lib/constants";
import { buildPaymentRequired, verifyPayment } from "../services/x402";

const briefRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/brief — get the most recent compiled brief
briefRouter.get("/api/brief", async (c) => {
  const format = c.req.query("format") ?? "json";
  const brief = await getLatestBrief(c.env);

  if (!brief) {
    return c.json(
      {
        error: "No briefs compiled yet",
        hint: "POST /api/brief/compile to compile the first brief",
      },
      404
    );
  }

  if (format === "text") {
    return new Response(brief.text, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  }

  const jsonData = brief.json_data ? (JSON.parse(brief.json_data) as Record<string, unknown>) : {};

  return c.json({
    date: brief.date,
    compiled_at: brief.compiled_at,
    inscribed_txid: brief.inscribed_txid ?? null,
    inscription_id: brief.inscription_id ?? null,
    ...jsonData,
    text: brief.text,
  });
});

// GET /api/brief/:date — get a specific brief by date (with optional x402 paywall)
briefRouter.get("/api/brief/:date", async (c) => {
  const date = c.req.param("date");

  // Validate date format YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
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
  if (!BRIEFS_FREE) {
    const paymentHeader =
      c.req.header("X-PAYMENT") ?? c.req.header("payment-signature");

    if (!paymentHeader) {
      return buildPaymentRequired({
        amount: BRIEF_PRICE_SATS,
        description: `Access to aibtc.news daily brief for ${date}`,
      });
    }

    const verification = await verifyPayment(paymentHeader, BRIEF_PRICE_SATS);
    if (!verification.valid) {
      return c.json({ error: "Payment verification failed" }, 402);
    }

    // Record earnings split: correspondent share + treasury remainder
    const correspondentShare = Math.floor(BRIEF_PRICE_SATS * CORRESPONDENT_SHARE);
    if (verification.payer) {
      await recordEarning(c.env, {
        btc_address: verification.payer,
        amount_sats: correspondentShare,
        reason: "brief-revenue",
        reference_id: verification.txid ?? null,
      });
    }
  }

  const format = c.req.query("format") ?? "json";

  if (format === "text") {
    return new Response(brief.text, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  }

  const jsonData = brief.json_data ? (JSON.parse(brief.json_data) as Record<string, unknown>) : {};

  return c.json({
    date: brief.date,
    compiled_at: brief.compiled_at,
    inscribed_txid: brief.inscribed_txid ?? null,
    inscription_id: brief.inscription_id ?? null,
    ...jsonData,
    text: brief.text,
  });
});

export { briefRouter };
