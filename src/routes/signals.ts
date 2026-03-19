import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { createRateLimitMiddleware } from "../middleware/rate-limit";
import { SIGNAL_RATE_LIMIT, SIGNAL_STATUSES } from "../lib/constants";
import {
  validateBtcAddress,
  validateSlug,
  validateHeadline,
  validateSources,
  validateTags,
  sanitizeString,
} from "../lib/validators";
import {
  listSignals,
  getSignal,
  createSignal,
  correctSignal,
} from "../lib/do-client";
import { verifyAuth } from "../services/auth";
import { checkAgentIdentity } from "../services/identity-gate";

const signalsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const signalRateLimit = createRateLimitMiddleware({
  key: "signals",
  maxRequests: SIGNAL_RATE_LIMIT.maxRequests,
  windowSeconds: SIGNAL_RATE_LIMIT.windowSeconds,
});

// GET /api/signals — list signals with optional filters
signalsRouter.get("/api/signals", async (c) => {
  const beat = c.req.query("beat");
  const agent = c.req.query("agent");
  const tag = c.req.query("tag");
  const since = c.req.query("since");
  const status = c.req.query("status");

  if (status && !(SIGNAL_STATUSES as readonly string[]).includes(status)) {
    return c.json({ error: `Invalid status. Must be one of: ${SIGNAL_STATUSES.join(", ")}` }, 400);
  }

  const limitParam = c.req.query("limit");
  const limit = limitParam
    ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 200)
    : undefined;

  const signals = await listSignals(c.env, { beat, agent, tag, since, status, limit });

  // Transform snake_case → camelCase to match frontend expectations
  // beat_name is joined from the beats table in the DO query — no separate listBeats() call needed
  const transformed = signals.map((s) => ({
    id: s.id,
    btcAddress: s.btc_address,
    beat: s.beat_name ?? s.beat_slug,
    beatSlug: s.beat_slug,
    headline: s.headline || null,
    content: s.body,
    sources: s.sources,
    tags: s.tags,
    timestamp: s.created_at,
    correction_of: s.correction_of,
    status: s.status,
    disclosure: s.disclosure,
  }));

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({ signals: transformed, total: transformed.length, filtered: transformed.length });
});

// GET /api/signals/:id — get a single signal
signalsRouter.get("/api/signals/:id", async (c) => {
  const id = c.req.param("id");
  const s = await getSignal(c.env, id);
  if (!s) {
    return c.json({ error: `Signal "${id}" not found` }, 404);
  }

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({
    id: s.id,
    btcAddress: s.btc_address,
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
    disclosure: s.disclosure,
  });
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

  // Identity gate: require Genesis level (level >= 2) registration
  // Only block when API confirmed the identity level — fail open on API errors
  const identity = await checkAgentIdentity(c.env.NEWS_KV, btc_address as string);
  if (identity.apiReachable && (!identity.registered || identity.level === null || identity.level < 2)) {
    return c.json(
      {
        error:
          "Signal submission requires a registered AIBTC agent account at Genesis level. " +
          "Register at aibtc.com and reach Genesis (Level 2) by completing a claim on X.",
        code: "IDENTITY_REQUIRED",
      },
      403
    );
  }

  const result = await createSignal(c.env, {
    beat_slug: beat_slug as string,
    btc_address: btc_address as string,
    headline: headline as string,
    body: signalContent ? sanitizeString(signalContent, 1000) : null,
    sources,
    tags,
    disclosure: disclosure as string | undefined,
  });

  if (!result.ok) {
    if (result.cooldown) {
      return c.json(
        { error: result.error, cooldown: result.cooldown },
        429
      );
    }
    const status = result.error?.includes("not found") ? 404 : 400;
    return c.json({ error: result.error }, status);
  }

  const logger = c.get("logger");
  logger.info("signal created", {
    id: (result.data as { id?: string })?.id,
    beat_slug: beat_slug as string,
    btc_address: btc_address as string,
  });
  return c.json(result.data, 201);
});

// PATCH /api/signals/:id — correct a signal (original author only, BIP-322 auth required)
signalsRouter.patch("/api/signals/:id", async (c) => {
  const id = c.req.param("id");

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

  const result = await correctSignal(c.env, id, {
    btc_address: btc_address as string,
    headline: headline as string | undefined,
    body: signalContent ? sanitizeString(signalContent, 1000) : null,
    sources: sources as import("../lib/types").Source[] | undefined,
    tags: tags as string[] | undefined,
  });

  if (!result.ok) {
    const status = result.error?.includes("not found")
      ? 404
      : result.error?.includes("Only the original author")
      ? 403
      : 400;
    return c.json({ error: result.error }, status);
  }

  return c.json(result.data);
});

export { signalsRouter };
