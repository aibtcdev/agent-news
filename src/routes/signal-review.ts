/**
 * Signal review routes — Publisher-only editorial actions.
 *
 * PATCH /api/signals/:id/review — approve, reject, or change signal status
 * GET   /api/front-page — curated signals (approved + brief_included only)
 */

import { Hono } from "hono";
import type { Env, AppVariables, SignalStatus } from "../lib/types";
import { createRateLimitMiddleware } from "../middleware/rate-limit";
import { reviewSignal, listSignals, listFrontPagePage } from "../lib/do-client";
import { validateBtcAddress } from "../lib/validators";
import { verifyAuth } from "../services/auth";
import { REVIEW_RATE_LIMIT, SIGNAL_STATUSES } from "../lib/constants";

const signalReviewRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const reviewRateLimit = createRateLimitMiddleware({
  key: "signal-review",
  ...REVIEW_RATE_LIMIT,
});

// PATCH /api/signals/:id/review — Publisher reviews a signal (BIP-322 auth required)
signalReviewRouter.patch("/api/signals/:id/review", reviewRateLimit, async (c) => {
  const signalId = c.req.param("id");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { btc_address, status, feedback } = body;

  if (!btc_address) {
    return c.json({ error: "Missing required field: btc_address" }, 400);
  }
  if (!status) {
    return c.json({ error: "Missing required field: status" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json({ error: "Invalid BTC address format" }, 400);
  }

  if (!(SIGNAL_STATUSES as readonly string[]).includes(status as string)) {
    return c.json({
      error: `Invalid status. Must be one of: ${SIGNAL_STATUSES.join(", ")}`,
    }, 400);
  }

  // BIP-322 auth
  const authResult = verifyAuth(
    c.req.raw.headers,
    btc_address as string,
    "PATCH",
    `/api/signals/${signalId}/review`
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  const result = await reviewSignal(c.env, signalId as string, {
    btc_address: btc_address as string,
    status: status as SignalStatus,
    feedback: feedback ? String(feedback) : null,
  });

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  const logger = c.get("logger");
  logger.info("signal reviewed", {
    signal_id: signalId,
    status,
    reviewer: btc_address,
  });

  const s = result.data as NonNullable<typeof result.data>;
  return c.json({
    id: s.id,
    btcAddress: s.btc_address,
    beat: s.beat_name ?? s.beat_slug,
    beatSlug: s.beat_slug,
    headline: s.headline,
    content: s.body,
    sources: s.sources,
    tags: s.tags,
    timestamp: s.created_at,
    status: s.status,
    publisherFeedback: s.publisher_feedback,
    reviewedAt: s.reviewed_at,
    disclosure: s.disclosure,
    correction_of: s.correction_of,
  });
});

// GET /api/front-page — curated signals (approved + brief_included only)
// Without ?before: returns all approved + brief_included signals (today's feed)
// With ?before=YYYY-MM-DD: returns one day of signals strictly before that date (infinite scroll)
signalReviewRouter.get("/api/front-page", async (c) => {
  const before = c.req.query("before") ?? null;
  const limitParam = c.req.query("limit");
  const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 200) : 50;

  // Paginated mode: infinite scroll request
  if (before !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) {
      return c.json({ error: "Invalid 'before' param (YYYY-MM-DD required)" }, 400);
    }
    // Validate it parses to a real date (rejects e.g. 2026-99-99)
    const parsed = new Date(before + "T12:00:00Z");
    if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== before) {
      return c.json({ error: "Invalid 'before' param (not a real date)" }, 400);
    }

    const result = await listFrontPagePage(c.env, before, limit);
    const transformed = result.signals.map((s) => ({
      id: s.id,
      btcAddress: s.btc_address,
      beat: s.beat_name ?? s.beat_slug,
      beatSlug: s.beat_slug,
      headline: s.headline,
      content: s.body,
      sources: s.sources,
      tags: s.tags,
      timestamp: s.created_at,
      status: s.status,
      disclosure: s.disclosure,
      correction_of: s.correction_of,
    }));

    c.header("Cache-Control", "public, max-age=60, s-maxage=300");
    return c.json({
      signals: transformed,
      date: result.date,
      hasMore: result.hasMore,
      curated: true,
    });
  }

  // Default mode: return all approved + brief_included signals (today's feed)
  const approved = await listSignals(c.env, { status: "approved", limit: 200 });
  const included = await listSignals(c.env, { status: "brief_included", limit: 200 });

  const all = [...approved, ...included];
  // Sort by created_at desc (most recent first)
  all.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const transformed = all.map((s) => ({
    id: s.id,
    btcAddress: s.btc_address,
    beat: s.beat_name ?? s.beat_slug,
    beatSlug: s.beat_slug,
    headline: s.headline,
    content: s.body,
    sources: s.sources,
    tags: s.tags,
    timestamp: s.created_at,
    status: s.status,
    disclosure: s.disclosure,
    correction_of: s.correction_of,
  }));

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({
    signals: transformed,
    total: transformed.length,
    curated: true,
  });
});

export { signalReviewRouter };
