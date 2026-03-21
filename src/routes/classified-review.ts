/**
 * Classified review routes — Publisher-only editorial actions.
 *
 * PATCH /api/classifieds/:id/review — approve or reject a classified
 * PATCH /api/classifieds/:id/refund — record refund txid after rejection
 * GET   /api/classifieds/pending    — list classifieds awaiting review
 */

import { Hono } from "hono";
import type { Env, AppVariables, ClassifiedStatus } from "../lib/types";
import { createRateLimitMiddleware } from "../middleware/rate-limit";
import { reviewClassified, recordClassifiedRefund, listPendingClassifieds } from "../lib/do-client";
import { transformClassified } from "./classifieds";
import { validateBtcAddress } from "../lib/validators";
import { verifyAuth } from "../services/auth";
import { REVIEW_RATE_LIMIT } from "../lib/constants";

const classifiedReviewRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const reviewRateLimit = createRateLimitMiddleware({
  key: "classified-review",
  ...REVIEW_RATE_LIMIT,
});

// PATCH /api/classifieds/:id/review — Publisher reviews a classified (BIP-322 auth required)
classifiedReviewRouter.patch("/api/classifieds/:id/review", reviewRateLimit, async (c) => {
  const classifiedId = c.req.param("id");

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

  // Only approved/rejected are valid review actions (pending_review is the initial state, not a review target)
  const REVIEW_STATUSES = ["approved", "rejected"] as const;
  if (!status || !(REVIEW_STATUSES as readonly string[]).includes(status as string)) {
    return c.json({
      error: `Invalid status. Must be one of: ${REVIEW_STATUSES.join(", ")}`,
    }, 400);
  }

  // BIP-322 auth
  const authResult = verifyAuth(
    c.req.raw.headers,
    btc_address as string,
    "PATCH",
    `/api/classifieds/${classifiedId}/review`
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  const result = await reviewClassified(c.env, classifiedId as string, {
    btc_address: btc_address as string,
    status: status as ClassifiedStatus,
    feedback: feedback ? String(feedback) : null,
  });

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  const logger = c.get("logger");
  logger.info("classified reviewed", {
    classified_id: classifiedId,
    status,
    reviewer: btc_address,
  });

  return c.json(transformClassified(result.data as NonNullable<typeof result.data>));
});

// PATCH /api/classifieds/:id/refund — Publisher records refund txid (BIP-322 auth required)
classifiedReviewRouter.patch("/api/classifieds/:id/refund", reviewRateLimit, async (c) => {
  const classifiedId = c.req.param("id");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { btc_address, refund_txid } = body;

  if (!btc_address) {
    return c.json({ error: "Missing required field: btc_address" }, 400);
  }
  if (!refund_txid) {
    return c.json({ error: "Missing required field: refund_txid" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json({ error: "Invalid BTC address format" }, 400);
  }

  // BIP-322 auth
  const authResult = verifyAuth(
    c.req.raw.headers,
    btc_address as string,
    "PATCH",
    `/api/classifieds/${classifiedId}/refund`
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  const result = await recordClassifiedRefund(c.env, classifiedId as string, {
    btc_address: btc_address as string,
    refund_txid: refund_txid as string,
  });

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  const logger = c.get("logger");
  logger.info("classified refund recorded", {
    classified_id: classifiedId,
    refund_txid,
    reviewer: btc_address,
  });

  return c.json(transformClassified(result.data as NonNullable<typeof result.data>));
});

// GET /api/classifieds/pending — list classifieds awaiting review (Publisher, BIP-322 auth required)
classifiedReviewRouter.get("/api/classifieds/pending", reviewRateLimit, async (c) => {
  const btcAddress = c.req.header("X-BTC-Address");
  if (!btcAddress) {
    return c.json({ error: "Missing X-BTC-Address header" }, 401);
  }

  // BIP-322 auth
  const authResult = verifyAuth(
    c.req.raw.headers,
    btcAddress,
    "GET",
    "/api/classifieds/pending"
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  const classifieds = await listPendingClassifieds(c.env, btcAddress);
  const transformed = classifieds.map(transformClassified);

  return c.json({ classifieds: transformed, total: transformed.length });
});

export { classifiedReviewRouter };
