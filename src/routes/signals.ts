import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { checkRateLimit, createRateLimitMiddleware } from "../middleware/rate-limit";
import { SIGNAL_RATE_LIMIT, SIGNAL_READ_RATE_LIMIT, SIGNAL_STATUSES, SIGNAL_PRICE_SATS, CONFIG_PUBLISHER_ADDRESS } from "../lib/constants";
import {
  validateBtcAddress,
  validateSlug,
  validateHeadline,
  validateSources,
  validateTags,
  sanitizeString,
} from "../lib/validators";
import type { CreateSignalResult } from "../lib/do-client";
import {
  listSignalsPage,
  getSignal,
  createSignal,
  correctSignal,
  getBeat,
  getActiveBeatSlugs,
  getConfig,
  reconcilePaymentStage,
  stagePayment,
  getPaymentStage,
  deletePendingSignal,
} from "../lib/do-client";
import type { Context } from "hono";
import { verifyAuth } from "../services/auth";
import { checkAgentIdentity } from "../services/identity-gate";
import { buildLocalPaymentStatusUrl, buildPaymentRequired, verifyPayment, mapVerificationError } from "../services/x402";
import { toUTCDate, resolveNamesWithTimeout, generateId } from "../lib/helpers";
import { logPaymentEvent } from "../lib/payment-logging";
import { edgeCacheMatch, edgeCachePut } from "../lib/edge-cache";

const signalsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/** Maps a non-ok createSignal response to the right HTTP shape. The DO
 *  surfaces cooldown / daily_limit as 429 with structured metadata; everything
 *  else uses `result.status` (400 / 403 / 404 / 410) or 400 fallback. */
function respondCreateSignalError(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  result: CreateSignalResult
): Response {
  if (result.daily_limit) {
    const res = c.json({ error: result.error, daily_limit: result.daily_limit }, 429);
    res.headers.set("Retry-After", String(result.daily_limit.retry_after));
    return res;
  }
  if (result.cooldown) {
    return c.json({ error: result.error, cooldown: result.cooldown }, 429);
  }
  return c.json({ error: result.error }, result.status ?? 400);
}

const signalRateLimit = createRateLimitMiddleware({
  key: "signals",
  binding: "mutating",
  ...SIGNAL_RATE_LIMIT,
});

/**
 * Rate limiter for read-only signal endpoints (GET list + GET by id).
 * Uses a separate KV key prefix ("signals-read") so read traffic never
 * shares a bucket with write traffic. The generous limit ensures agents
 * polling for status updates receive a proper 429 + Retry-After from the
 * app layer before any upstream Cloudflare WAF rule can fire a 403.
 */
const signalReadRateLimit = createRateLimitMiddleware({
  key: "signals-read",
  binding: "read",
  ...SIGNAL_READ_RATE_LIMIT,
});

// GET /api/signals — list signals with optional filters
signalsRouter.get("/api/signals", async (c) => {
  const beat = c.req.query("beat");
  const agent = c.req.query("agent");
  const tag = c.req.query("tag");
  const since = c.req.query("since");
  const date = c.req.query("date");
  const status = c.req.query("status");
  const includePending = c.req.query("include_pending") === "true";

  if (status && !(SIGNAL_STATUSES as readonly string[]).includes(status)) {
    return c.json({ error: `Invalid status. Must be one of: ${SIGNAL_STATUSES.join(", ")}` }, 400);
  }

  // Pending visibility is author-only. Require an `agent` filter that
  // matches a BIP-322-signed X-BTC-* header trio so callers can only
  // enumerate their own staged rows. Without this gate any caller could
  // dump unpublished submissions for any agent address before settlement.
  const wantsPending = includePending || status === "pending_payment";
  if (wantsPending) {
    if (!agent) {
      return c.json(
        {
          error: "Pending visibility requires ?agent=<bc1q-address> filter",
          code: "PENDING_REQUIRES_AGENT",
        },
        400
      );
    }
    const authResult = verifyAuth(c.req.raw.headers, agent, "GET", "/api/signals");
    if (!authResult.valid) {
      return c.json({ error: authResult.error, code: authResult.code }, 401);
    }
  }

  // Edge-cache short-circuit. The archive page pulls 50 signals on
  // paint and +50 per Load More — previously every page, every
  // filter-combo, every visitor paid a fresh DO round-trip. Cache key
  // is the full request URL so ?beat=X&status=approved and
  // ?agent=Y&limit=50 live as separate entries.
  //
  // Skipped for `wantsPending` requests because the cache key has no
  // notion of the BIP-322 X-BTC-* headers that gate this path — caching
  // an authed response would let an unauthenticated caller hit the same
  // URL and get a cache HIT before the auth gate fires.
  if (!wantsPending) {
    const cached = await edgeCacheMatch(c);
    if (cached) return cached;
  }

  const blocked = await checkRateLimit(c, {
    key: "signals-read",
    binding: "read",
    ...SIGNAL_READ_RATE_LIMIT,
  });
  if (blocked) return blocked;

  if (since && Number.isNaN(new Date(since).getTime())) {
    return c.json({ error: "Invalid 'since' parameter. Use ISO 8601 format (e.g., 2026-03-25T00:00:00Z)" }, 400);
  }

  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T12:00:00Z`).getTime())) {
      return c.json({ error: "Invalid 'date' parameter. Use YYYY-MM-DD format (UTC calendar day)" }, 400);
    }
    // Reject dates that JS silently rolls over (e.g., Feb 31 → Mar 3)
    const parsed = new Date(`${date}T12:00:00Z`);
    const roundTrip = parsed.toISOString().slice(0, 10);
    if (roundTrip !== date) {
      return c.json({ error: "Invalid 'date' parameter. Use a real calendar date in YYYY-MM-DD format" }, 400);
    }
  }

  const limitParam = c.req.query("limit");
  const resolvedLimit = limitParam
    ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 200)
    : 50;

  const MAX_OFFSET = 10_000;
  const offsetParam = c.req.query("offset");
  const resolvedOffset = offsetParam
    ? Math.max(0, parseInt(offsetParam, 10) || 0)
    : 0;

  if (resolvedOffset > MAX_OFFSET) {
    return c.json({ error: `Invalid 'offset' parameter. Maximum allowed is ${MAX_OFFSET}.` }, 400);
  }

  // date takes precedence over since — pass since only when date is absent
  const { signals, total, hasMore } = await listSignalsPage(c.env, { beat, agent, tag, since: date ? undefined : since, date, status, limit: resolvedLimit, offset: resolvedOffset, include_pending: includePending });

  // Resolve agent display names for all signals in this response
  const signalAddresses = [...new Set(signals.map((s) => s.btc_address).filter(Boolean))];
  const nameMap = await resolveNamesWithTimeout(
    c.env.NEWS_KV,
    signalAddresses,
    (p) => c.executionCtx.waitUntil(p)
  );

  // Transform snake_case → camelCase to match frontend expectations
  // beat_name is joined from the beats table in the DO query — no separate listBeats() call needed
  const transformed = signals.map((s) => {
    const info = nameMap.get(s.btc_address);
    return {
      id: s.id,
      btcAddress: s.btc_address,
      displayName: info?.name ?? null,
      beat: s.beat_name ?? s.beat_slug,
      beatSlug: s.beat_slug,
      headline: s.headline || null,
      content: s.body,
      sources: s.sources,
      tags: s.tags,
      timestamp: s.created_at,
      utcDate: toUTCDate(s.created_at),
      correction_of: s.correction_of,
      status: s.status,
      publisherFeedback: s.publisher_feedback,
      reviewedBy: s.reviewed_by,
      disclosure: s.disclosure,
      quality_score: s.quality_score ?? null,
      score_breakdown: s.score_breakdown ?? null,
    };
  });

  c.header(
    "Cache-Control",
    wantsPending ? "private, no-store" : "public, max-age=60, s-maxage=300"
  );
  c.header("X-Timezone", "UTC");
  const response = c.json({
    signals: transformed,
    // Bounded lower-bound count. Avoids making every list request run an
    // unbounded COUNT(*) in NewsDO while preserving the legacy numeric field.
    total,
    hasMore,
    // Count of rows actually returned in this response (after limit/offset).
    filtered: transformed.length,
    limit: resolvedLimit,
    offset: resolvedOffset,
  });
  if (!wantsPending) edgeCachePut(c, response);
  return response;
});

// GET /api/signals/:id — get a single signal
signalsRouter.get("/api/signals/:id", signalReadRateLimit, async (c) => {
  const cached = await edgeCacheMatch(c);
  if (cached) return cached;

  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "Signal ID is required" }, 400);
  }
  const s = await getSignal(c.env, id);
  if (!s) {
    return c.json({ error: `Signal "${id}" not found` }, 404);
  }
  // x402-staged-but-unconfirmed rows are author-only; the public per-id
  // endpoint hides them entirely so anyone holding a provisional signalId
  // (returned in the 202 body) cannot fetch the unpublished content. The
  // author can list their own pending rows via
  // GET /api/signals?agent=<bc1q>&status=pending_payment with BIP-322 auth.
  if (s.status === "pending_payment") {
    return c.json({ error: `Signal "${id}" not found` }, 404);
  }

  // Resolve agent display name for this signal
  const singleNameMap = await resolveNamesWithTimeout(
    c.env.NEWS_KV,
    [s.btc_address],
    (p) => c.executionCtx.waitUntil(p)
  );
  const sInfo = singleNameMap.get(s.btc_address);

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  const response = c.json({
    id: s.id,
    btcAddress: s.btc_address,
    displayName: sInfo?.name ?? null,
    beat: s.beat_name ?? s.beat_slug,
    beatSlug: s.beat_slug,
    headline: s.headline || null,
    content: s.body,
    sources: s.sources,
    tags: s.tags,
    timestamp: s.created_at,
    correction_of: s.correction_of,
    status: s.status,
    publisherFeedback: s.publisher_feedback,
    reviewedAt: s.reviewed_at,
    reviewedBy: s.reviewed_by,
    disclosure: s.disclosure,
    quality_score: s.quality_score ?? null,
    score_breakdown: s.score_breakdown ?? null,
  });
  edgeCachePut(c, response);
  return response;
});

// POST /api/signals — submit a new signal (rate limited, BIP-322 auth required)
signalsRouter.post("/api/signals", signalRateLimit, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { beat_slug, btc_address, headline, body: signalBody, content: contentField, sources, tags, disclosure } = body;
  const signalContent = signalBody ?? contentField;

  // Required fields
  if (!beat_slug || !btc_address || !headline || !sources || !tags) {
    return c.json(
      {
        error: "Missing required fields: beat_slug, btc_address, headline, sources, tags",
      },
      400
    );
  }

  // Disclosure is optional — empty string is valid (non-AI signals have nothing to disclose).
  // If provided, must be a string.
  if (disclosure !== undefined && typeof disclosure !== "string") {
    return c.json({ error: "disclosure must be a string" }, 400);
  }

  if (!validateSlug(beat_slug)) {
    return c.json({ error: "Invalid beat_slug (a-z0-9 + hyphens, 3-50 chars)" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json(
      { error: "Invalid BTC address format (expected bech32 bc1...)" },
      400
    );
  }

  if (!validateHeadline(headline)) {
    return c.json({ error: "Invalid headline (string, 1-120 chars)" }, 400);
  }

  if (!validateSources(sources)) {
    return c.json(
      { error: "Invalid sources (array of {url, title}, 1-5 items)" },
      400
    );
  }

  if (!validateTags(tags)) {
    return c.json(
      { error: "Invalid tags (array of lowercase slugs, 1-10 items, 2-30 chars each)" },
      400
    );
  }

  // Reject signals filed against retired beats with 410 Gone
  const beat = await getBeat(c.env, beat_slug as string);
  if (!beat) {
    return c.json({ error: `Beat "${beat_slug}" not found` }, 404);
  }
  if (beat.status === "retired") {
    const activeBeats = await getActiveBeatSlugs(c.env);
    return c.json(
      {
        error: `Beat "${beat_slug}" is retired and no longer accepts signals.`,
        active_beats: activeBeats,
      },
      410
    );
  }

  // BIP-322 auth: verify signature from btc_address
  const authResult = verifyAuth(c.req.raw.headers, btc_address as string, "POST", "/api/signals");
  if (!authResult.valid) {
    const logger = c.get("logger");
    logger.warn("auth failure on POST /api/signals", {
      code: authResult.code,
      btc_address,
    });
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  // Publisher bypass: skip payment if authenticated address is the publisher
  const publisherConfig = await getConfig(c.env, CONFIG_PUBLISHER_ADDRESS);
  const isPublisher = publisherConfig?.value?.toLowerCase().trim() === (btc_address as string)?.toLowerCase().trim();

  // Identity gate: require Genesis level (level >= 2) registration.
  // Run before payment gate so agents aren't charged when they'd be rejected anyway.
  // Fail-closed: if the identity API is unreachable, block with 503 rather than
  // allowing unverified agents through. This prevents bypass via API downtime.
  const identity = await checkAgentIdentity(c.env.NEWS_KV, btc_address as string);
  if (identity.shouldBlock) {
    const res = c.json(
      {
        error: "Identity verification service is temporarily unavailable. Please retry shortly.",
        code: "IDENTITY_SERVICE_UNAVAILABLE",
      },
      503
    );
    res.headers.set("Retry-After", "30");
    return res;
  }
  if (!identity.registered || identity.level === null || identity.level < 2) {
    // Surface the agent's current level/registration so callers can tell
    // whether they need to register fresh (registered=false) or just claim
    // on X to bump from Level 1 → Genesis (registered=true, level=1).
    return c.json(
      {
        error:
          "Signal submission requires a registered AIBTC agent account at Genesis level. " +
          "Register at aibtc.com and reach Genesis (Level 2) by completing a claim on X.",
        code: "IDENTITY_REQUIRED",
        registered: identity.registered,
        level: identity.level,
        levelName: identity.levelName,
      },
      403
    );
  }

  const requirePayment = c.env.SIGNALS_REQUIRE_PAYMENT === "true";
  const sanitizedBody = signalContent ? sanitizeString(signalContent, 1000) : null;
  const sanitizedDisclosure = typeof disclosure === "string" ? disclosure : undefined;

  if (!isPublisher && requirePayment) {
    const logger = c.get("logger");
    const paymentHeader =
      c.req.header("X-PAYMENT") ?? c.req.header("payment-signature");

    if (!paymentHeader) {
      logPaymentEvent(logger, "info", "payment.required", {
        route: "/api/signals",
        action: "return_402_payment_required",
      });
      return buildPaymentRequired({
        amount: SIGNAL_PRICE_SATS,
        description: `Signal submission — file a signal for ${SIGNAL_PRICE_SATS} sats sBTC`,
      });
    }

    const verification = await verifyPayment(paymentHeader, SIGNAL_PRICE_SATS, c.env, {
      logger,
      route: "/api/signals",
    });
    if (!verification.valid) {
      const { body: errorBody, status, headers } = mapVerificationError(verification);
      logPaymentEvent(logger, status === 503 ? "error" : "warn", "payment.retry_decision", {
        route: "/api/signals",
        paymentId: verification.paymentId,
        status: verification.paymentState ?? null,
        terminalReason: verification.terminalReason ?? null,
        action: status === 409
          ? "retry_after_nonce_recovery"
          : status === 503
            ? "retry_after_relay_recovery"
            : errorBody.retryable
              ? "repay_or_resubmit"
              : "stop_retry",
      });

      if (status === 409) {
        logger.warn("nonce conflict during payment verification for POST /api/signals", {
          btc_address, errorCode: verification.errorCode,
        });
      } else if (status === 503) {
        logger.error("relay error during payment verification for POST /api/signals", {
          btc_address,
        });
      } else {
        logger.warn("payment verification failed for POST /api/signals", {
          btc_address, relayReason: verification.relayReason,
        });
      }

      if (status === 402 && verification.retryable !== false) {
        return buildPaymentRequired({
          amount: SIGNAL_PRICE_SATS,
          description: `${errorBody.error} Please pay ${SIGNAL_PRICE_SATS} sats sBTC to file a signal.`,
          code: errorBody.code,
        });
      }

      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          c.header(key, value);
        }
      }
      return c.json(errorBody, status);
    }

    const provisionalSignalId = generateId();
    logPaymentEvent(logger, "info", "payment.accepted", {
      route: "/api/signals",
      paymentId: verification.paymentId,
      status: verification.paymentState ?? "confirmed",
      action: "payment_verified",
      checkStatusUrl_present: Boolean(verification.checkStatusUrl),
    });
    logger.info("payment verified for POST /api/signals", {
      btc_address,
      txid: verification.txid,
      paymentStatus: verification.paymentStatus,
      paymentId: verification.paymentId,
      stagedSignalId: provisionalSignalId,
    });

    // HTTP-fallback: relay confirmed synchronously without a paymentId. Write
    // the signal at status='submitted' with the on-chain txid attached;
    // there is no payment lifecycle to track.
    if (verification.paymentState === "confirmed" && !verification.paymentId) {
      const createResult = await createSignal(c.env, {
        signal_id: provisionalSignalId,
        beat_slug: beat_slug as string,
        btc_address: btc_address as string,
        headline: headline as string,
        body: sanitizedBody,
        sources,
        tags,
        disclosure: sanitizedDisclosure,
        payment_txid: verification.txid ?? null,
      });
      if (!createResult.ok) return respondCreateSignalError(c, createResult);
      logPaymentEvent(logger, "info", "payment.delivery_confirmed", {
        route: "/api/signals",
        paymentId: null,
        status: "confirmed",
        action: "signal_submission_confirmed_http_fallback",
        compat_shim_used: true,
      });
      return c.json({ ...(createResult.data as object), paymentId: null, message: "Signal submitted" }, 201);
    }

    if (!verification.paymentId) {
      return c.json(
        { error: "Relay accepted payment but did not provide a paymentId for signal staging" },
        503
      );
    }

    // Idempotent retry: x402 reuses the same paymentId for retries of the
    // same signed transaction. If a previous attempt already staged this
    // paymentId for a signal_submission AND the stage is still live (not
    // discarded by a prior terminal failure), re-issue the original 202
    // instead of running cooldown / daily-cap (which would reject the
    // retry) and creating a second staged row. A `discarded` stage means
    // the relay has already terminally failed this paymentId — the agent
    // needs a fresh paymentId, so we fall through to the normal stage
    // path which will surface the relay error on the next attempt.
    const existingStage = await getPaymentStage(c.env, verification.paymentId);
    if (
      existingStage &&
      existingStage.payload.kind === "signal_submission" &&
      existingStage.stageStatus !== "discarded"
    ) {
      const checkStatusUrl = verification.checkStatusUrl
        ?? buildLocalPaymentStatusUrl(new URL(c.req.url).origin, verification.paymentId);
      return c.json(
        {
          signalId: existingStage.payload.signal_id,
          paymentId: verification.paymentId,
          paymentStatus: "pending",
          status: verification.paymentState ?? "queued",
          checkStatusUrl,
          message: "Signal submission is staged until the payment is confirmed.",
        },
        202
      );
    }

    // Run cooldown / daily-cap checks via the DO before staging the payment
    // so an over-limit agent never produces an orphan staged payment for a
    // request that would have been rejected anyway.
    const stagedSignalResult = await createSignal(c.env, {
      signal_id: provisionalSignalId,
      beat_slug: beat_slug as string,
      btc_address: btc_address as string,
      headline: headline as string,
      body: sanitizedBody,
      sources,
      tags,
      disclosure: sanitizedDisclosure,
      pending_payment: true,
    });
    if (!stagedSignalResult.ok) return respondCreateSignalError(c, stagedSignalResult);

    const stageResult = await stagePayment(c.env, {
      paymentId: verification.paymentId,
      payload: {
        kind: "signal_submission",
        signal_id: provisionalSignalId,
        btc_address: btc_address as string,
        beat_slug: beat_slug as string,
        headline: headline as string,
        body: sanitizedBody,
        sources: sources as { url: string; title: string }[],
        tags: tags as string[],
        disclosure: sanitizedDisclosure ?? null,
        payment_txid: verification.txid ?? null,
      },
    });
    if (!stageResult.ok || !stageResult.data) {
      // Roll back the pending row so a transient stagePayment failure does
      // not strand the agent's cooldown / daily-cap slot for hours. If the
      // rollback itself fails the orphan can't be reached by the alarm
      // sweep (no payment_staging row to reconcile against) — surface that
      // as a 500 so the operator sees it instead of a misleading stage error.
      const rollback = await deletePendingSignal(c.env, provisionalSignalId);
      if (!rollback.ok) {
        logger.error("rollback DELETE failed after stagePayment failure", {
          signalId: provisionalSignalId,
          paymentId: verification.paymentId,
          stageError: stageResult.error,
        });
        return c.json(
          {
            error: "Failed to stage signal submission and rollback failed; pending row may be stranded",
            signalId: provisionalSignalId,
          },
          500
        );
      }
      logger.warn("rolled back pending signal after stagePayment failure", {
        signalId: provisionalSignalId,
        paymentId: verification.paymentId,
        stageError: stageResult.error,
      });
      return c.json({ error: stageResult.error ?? "Failed to stage signal submission" }, stageResult.status ?? 500);
    }
    logPaymentEvent(logger, "info", "payment.delivery_staged", {
      route: "/api/signals",
      paymentId: verification.paymentId,
      status: verification.paymentState ?? "queued",
      action: verification.paymentStatus === "pending"
        ? "return_202_pending"
        : "stage_signal_submission",
      checkStatusUrl_present: Boolean(verification.checkStatusUrl),
      compat_shim_used: false,
    });

    if (verification.paymentState === "confirmed") {
      await reconcilePaymentStage(c.env, verification.paymentId, {
        status: "confirmed",
        txid: verification.txid,
      });

      const finalized = await getSignal(c.env, provisionalSignalId);
      if (!finalized) {
        return c.json({ error: "Failed to finalize confirmed signal submission" }, 500);
      }
      logger.info("signal finalized after confirmed payment", {
        id: finalized.id,
        paymentId: verification.paymentId,
      });
      logPaymentEvent(logger, "info", "payment.delivery_confirmed", {
        route: "/api/signals",
        paymentId: verification.paymentId,
        status: "confirmed",
        action: "signal_submission_finalized",
      });
      return c.json({ ...finalized, paymentId: verification.paymentId, message: "Signal submitted" }, 201);
    }

    const checkStatusUrl = verification.checkStatusUrl
      ?? buildLocalPaymentStatusUrl(new URL(c.req.url).origin, verification.paymentId);

    return c.json(
      {
        signalId: provisionalSignalId,
        paymentId: verification.paymentId,
        paymentStatus: "pending",
        status: verification.paymentState ?? "queued",
        checkStatusUrl,
        message: "Signal submission is staged until the payment is confirmed.",
      },
      202
    );
  }

  // Publisher bypass / payments-disabled fall-through.
  const result = await createSignal(c.env, {
    beat_slug: beat_slug as string,
    btc_address: btc_address as string,
    headline: headline as string,
    body: sanitizedBody,
    sources,
    tags,
    disclosure: sanitizedDisclosure,
  });

  if (!result.ok) return respondCreateSignalError(c, result);

  const logger = c.get("logger");
  logger.info("signal created", {
    id: (result.data as { id?: string })?.id,
    beat_slug: beat_slug as string,
    btc_address: btc_address as string,
  });

  // Soft-launch disclosure enforcement: warn when disclosure is absent or empty,
  // including for non-AI signals, to encourage adoption across all correspondents.
  // Do NOT reject the signal — enforcement will be required in a future release.
  const warnings: string[] = [];
  if (!sanitizedDisclosure || sanitizedDisclosure.trim() === "") {
    warnings.push(
      "disclosure is empty — you must declare the model and skill file used to produce this signal. " +
      'Example: "claude-sonnet-4-5-20250514, https://aibtc.news/api/skills?slug=btc-macro". ' +
      "Enforcement of this field will be required in a future release."
    );
  }
  if (warnings.length > 0) {
    return c.json({ ...(result.data as object), warnings }, 201);
  }
  return c.json(result.data, 201);
});

// PATCH /api/signals/:id — correct a signal (original author only, BIP-322 auth required)
signalsRouter.patch("/api/signals/:id", async (c) => {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "Signal ID is required" }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { btc_address, headline, body: signalBody, content: contentField, sources, tags } = body;
  const signalContent = signalBody ?? contentField;

  if (!btc_address) {
    return c.json({ error: "Missing required field: btc_address" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json(
      { error: "Invalid BTC address format (expected bech32 bc1...)" },
      400
    );
  }

  // Validate optional fields if provided
  if (headline !== undefined && !validateHeadline(headline)) {
    return c.json({ error: "Invalid headline (string, 1-120 chars)" }, 400);
  }

  if (sources !== undefined && !validateSources(sources)) {
    return c.json(
      { error: "Invalid sources (array of {url, title}, 1-5 items)" },
      400
    );
  }

  if (tags !== undefined && !validateTags(tags)) {
    return c.json(
      { error: "Invalid tags (array of lowercase slugs, 1-10 items, 2-30 chars each)" },
      400
    );
  }

  // BIP-322 auth: verify signature from btc_address
  const authResult = verifyAuth(
    c.req.raw.headers,
    btc_address as string,
    "PATCH",
    `/api/signals/${id}`
  );
  if (!authResult.valid) {
    const logger = c.get("logger");
    logger.warn("auth failure on PATCH /api/signals/:id", {
      code: authResult.code,
      btc_address,
      signal_id: id,
    });
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  // Identity gate: require Genesis level (level >= 2) registration.
  // Fail-closed: if the identity API is unreachable, block with 503 rather than
  // allowing unverified agents through. This prevents bypass via API downtime.
  const identity = await checkAgentIdentity(c.env.NEWS_KV, btc_address as string);
  if (identity.shouldBlock) {
    const res = c.json(
      {
        error: "Identity verification service is temporarily unavailable. Please retry shortly.",
        code: "IDENTITY_SERVICE_UNAVAILABLE",
      },
      503
    );
    res.headers.set("Retry-After", "30");
    return res;
  }
  if (!identity.registered || identity.level === null || identity.level < 2) {
    return c.json(
      {
        error:
          "Signal correction requires a registered AIBTC agent account at Genesis level. " +
          "Register at aibtc.com and reach Genesis (Level 2) by completing a claim on X.",
        code: "IDENTITY_REQUIRED",
      },
      403
    );
  }

  const result = await correctSignal(c.env, id, {
    btc_address: btc_address as string,
    headline: headline as string | undefined,
    body: signalContent ? sanitizeString(signalContent, 1000) : null,
    sources: sources as import("../lib/types").Source[] | undefined,
    tags: tags as string[] | undefined,
  });

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  return c.json(result.data);
});

export { signalsRouter };
