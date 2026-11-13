import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getLatestBrief, getBriefByDate, getBriefWeek, listBriefDates, recordEarning, reconcilePaymentStage, stagePayment } from "../lib/do-client";
import { BRIEF_PRICE_SATS, CORRESPONDENT_SHARE } from "../lib/constants";
import { getUTCDate, resolveNamesWithTimeout } from "../lib/helpers";
import { logPaymentEvent } from "../lib/payment-logging";
import { validateDateFormat } from "../lib/validators";
import { buildLocalPaymentStatusUrl, buildPaymentRequired, verifyPayment, mapVerificationError } from "../services/x402";

const briefRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Flat, snake_case inscription fields read straight from the DB column — the
// same shape /api/brief/:date/inscription returns. Kept flat (not just the
// nested camelCase `.inscription` object) so a client can poll one canonical
// field across every brief surface, and always present (null before inscription)
// so that poll never hits an undefined path. Callers spread this AFTER
// `...jsonData` so the authoritative column wins over any stale inscription
// baked into the compile-time json_data blob (#870).
function flatInscriptionFields(brief: { inscription_id?: string | null; inscribed_txid?: string | null } | null) {
  return {
    inscription_id: brief?.inscription_id ?? null,
    inscribed_txid: brief?.inscribed_txid ?? null,
  };
}

// GET /api/brief — get today's compiled brief, or today's date with empty content if not yet compiled.
// Always returns today's UTC date so the frontend can show today's signal feed before the
// brief is compiled, rather than falling back to yesterday's stale brief.
briefRouter.get("/api/brief", async (c) => {
  const format = c.req.query("format") ?? "json";
  const today = getUTCDate();

  // A DO read failure must not fall through to the `compiledAt: null` branch
  // below — that branch means "no brief compiled yet", and answering it on a
  // timeout reports an unreachable DO as an authoritative absence (#699 notes
  // 30s-28min saturation bursts, so this is a live window, not a theoretical
  // one). Fail loudly and retryably instead.
  let brief: Awaited<ReturnType<typeof getLatestBrief>>;
  let archive: string[];
  try {
    [brief, archive] = await Promise.all([
      getLatestBrief(c.env),
      listBriefDates(c.env),
    ]);
  } catch (err) {
    c.header("Retry-After", "30");
    return c.json(
      {
        error: "Brief storage is temporarily unreachable — retry shortly.",
        detail: err instanceof Error ? err.message : String(err),
      },
      503
    );
  }

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
      ...flatInscriptionFields(null),
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
    ...flatInscriptionFields(todaysBrief),
  });
});

interface WeeklyIncludedSignalLike {
  signal_id?: string;
  btc_address?: string;
  beat_slug?: string | null;
}

interface WeeklySectionLike {
  id?: string;
  signalId?: string;
  correspondent?: string;
  beatSlug?: string | null;
}

// GET /api/brief/week/:week_iso — reduce 7 daily briefs starting at week_iso into a weekly summary (#898)
briefRouter.get("/api/brief/week/:week_iso", async (c) => {
  const weekIso = c.req.param("week_iso");

  if (!validateDateFormat(weekIso)) {
    return c.json(
      { error: "Invalid week_iso format", hint: "Use YYYY-MM-DD" },
      400
    );
  }
  const parsedStart = new Date(`${weekIso}T12:00:00Z`);
  if (
    Number.isNaN(parsedStart.getTime()) ||
    parsedStart.toISOString().slice(0, 10) !== weekIso
  ) {
    return c.json(
      { error: "Invalid week_iso calendar date", hint: "Use a valid YYYY-MM-DD date" },
      400
    );
  }

  let bundle: Awaited<ReturnType<typeof getBriefWeek>>;
  try {
    bundle = await getBriefWeek(c.env, weekIso);
  } catch (err) {
    c.header("Retry-After", "30");
    return c.json(
      {
        error: "Brief storage is temporarily unreachable — retry shortly.",
        detail: err instanceof Error ? err.message : String(err),
      },
      503
    );
  }

  // Group DB brief_signals by brief_date
  const dbSignalsByDate = new Map<
    string,
    Array<{ btc_address: string; beat_slug: string | null }>
  >();
  for (const row of bundle.signals) {
    const list = dbSignalsByDate.get(row.brief_date) ?? [];
    list.push({ btc_address: row.btc_address, beat_slug: row.beat_slug });
    dbSignalsByDate.set(row.brief_date, list);
  }

  const entryStats = new Map<
    string,
    { signal_count: number; beats: Set<string> }
  >();
  let totalSignals = 0;

  const dailyBriefs = bundle.briefs.map((brief) => {
    let jsonData: Record<string, unknown> = {};
    if (brief.json_data) {
      try {
        jsonData = JSON.parse(brief.json_data) as Record<string, unknown>;
      } catch {
        jsonData = {};
      }
    }

    // Prefer JSON included_signals, then DB brief_signals, then JSON sections
    let daySignals: Array<{ btc_address: string; beat_slug: string | null }> = [];
    if (Array.isArray(jsonData.included_signals) && jsonData.included_signals.length > 0) {
      daySignals = (jsonData.included_signals as WeeklyIncludedSignalLike[])
        .filter((s) => typeof s.btc_address === "string" && s.btc_address.length > 0)
        .map((s) => ({
          btc_address: s.btc_address as string,
          beat_slug: typeof s.beat_slug === "string" ? s.beat_slug : null,
        }));
    } else if ((dbSignalsByDate.get(brief.date)?.length ?? 0) > 0) {
      daySignals = dbSignalsByDate.get(brief.date) ?? [];
    } else if (Array.isArray(jsonData.sections) && jsonData.sections.length > 0) {
      daySignals = (jsonData.sections as WeeklySectionLike[])
        .filter((s) => typeof s.correspondent === "string" && s.correspondent.length > 0)
        .map((s) => ({
          btc_address: s.correspondent as string,
          beat_slug: typeof s.beatSlug === "string" ? s.beatSlug : null,
        }));
    }

    for (const sig of daySignals) {
      const existing = entryStats.get(sig.btc_address) ?? {
        signal_count: 0,
        beats: new Set<string>(),
      };
      existing.signal_count += 1;
      if (sig.beat_slug) {
        existing.beats.add(sig.beat_slug);
      }
      entryStats.set(sig.btc_address, existing);
    }

    totalSignals += daySignals.length;

    const nestedInscription =
      jsonData.inscription && typeof jsonData.inscription === "object"
        ? (jsonData.inscription as { inscriptionId?: string | null })
        : null;
    const inscriptionId =
      brief.inscription_id ?? nestedInscription?.inscriptionId ?? null;

    return {
      date: brief.date,
      inscription_id: inscriptionId,
      included_count: daySignals.length,
    };
  });

  const addresses = [...entryStats.keys()];
  const nameMap = await resolveNamesWithTimeout(
    c.env.NEWS_KV,
    addresses,
    (p) => c.executionCtx.waitUntil(p)
  );

  const entries = [...entryStats.entries()]
    .map(([btcAddress, stats]) => {
      const info = nameMap.get(btcAddress);
      return {
        btc_address: btcAddress,
        displayName: info?.name ?? null,
        signal_count: stats.signal_count,
        beats: [...stats.beats].sort((a, b) => a.localeCompare(b)),
      };
    })
    .sort(
      (a, b) =>
        b.signal_count - a.signal_count ||
        a.btc_address.localeCompare(b.btc_address)
    );

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({
    week: bundle.week,
    first_date: bundle.first_date,
    last_date: bundle.last_date,
    entries,
    total_signals: totalSignals,
    daily_briefs: dailyBriefs,
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

  // Distinguish "this brief does not exist" (404, below) from "we could not
  // read storage" (503) — collapsing both into 404 tells the caller a brief is
  // absent when it may be sitting in the DO.
  let brief: Awaited<ReturnType<typeof getBriefByDate>>;
  try {
    brief = await getBriefByDate(c.env, date);
  } catch (err) {
    c.header("Retry-After", "30");
    return c.json(
      {
        error: "Brief storage is temporarily unreachable — retry shortly.",
        detail: err instanceof Error ? err.message : String(err),
      },
      503
    );
  }

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
    ...flatInscriptionFields(brief),
  });
});

export { briefRouter };
