/**
 * Corrections routes — fact-checker role.
 *
 * POST  /api/signals/:id/corrections — file a correction (BIP-322 auth)
 * GET   /api/signals/:id/corrections — list corrections on a signal
 * PATCH /api/signals/:id/corrections/:correctionId — Publisher reviews correction
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { createRateLimitMiddleware } from "../middleware/rate-limit";
import { createCorrection, listCorrections, reviewCorrection } from "../lib/do-client";
import { validateBtcAddress } from "../lib/validators";
import { verifyAuth } from "../services/auth";
import { CORRECTION_RATE_LIMIT } from "../lib/constants";

const correctionsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const correctionRateLimit = createRateLimitMiddleware({
  key: "corrections",
  maxRequests: CORRECTION_RATE_LIMIT.maxRequests,
  windowSeconds: CORRECTION_RATE_LIMIT.windowSeconds,
});

// POST /api/signals/:id/corrections — file a correction
correctionsRouter.post("/api/signals/:id/corrections", correctionRateLimit, async (c) => {
  const signalId = c.req.param("id");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { btc_address, claim, correction, sources } = body;

  if (!btc_address || !claim || !correction) {
    return c.json({ error: "Missing required fields: btc_address, claim, correction" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json({ error: "Invalid BTC address format" }, 400);
  }

  if (typeof claim !== "string" || claim.trim().length === 0) {
    return c.json({ error: "claim must be a non-empty string" }, 400);
  }

  if (typeof correction !== "string" || correction.trim().length === 0) {
    return c.json({ error: "correction must be a non-empty string" }, 400);
  }

  // BIP-322 auth
  const authResult = verifyAuth(
    c.req.raw.headers,
    btc_address as string,
    "POST",
    `/api/signals/${signalId}/corrections`
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  // Sanitization is handled in the DO layer (authoritative boundary)
  const result = await createCorrection(c.env, {
    signal_id: signalId as string,
    btc_address: btc_address as string,
    claim: claim as string,
    correction: correction as string,
    sources: sources ? String(sources) : null,
  });

  if (!result.ok) {
    const status = result.error?.includes("not found") ? 404
      : result.error?.includes("own signal") ? 400
      : 400;
    return c.json({ error: result.error }, status);
  }

  const logger = c.get("logger");
  logger.info("correction filed", {
    signal_id: signalId,
    corrector: btc_address,
  });

  return c.json(result.data, 201);
});

// GET /api/signals/:id/corrections — list corrections on a signal
correctionsRouter.get("/api/signals/:id/corrections", async (c) => {
  const signalId = c.req.param("id");
  const corrections = await listCorrections(c.env, signalId);

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({ corrections, total: corrections.length });
});

// PATCH /api/signals/:id/corrections/:correctionId — Publisher reviews a correction
correctionsRouter.patch("/api/signals/:id/corrections/:correctionId", async (c) => {
  const correctionId = c.req.param("correctionId");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { btc_address, status } = body;

  if (!btc_address || !status) {
    return c.json({ error: "Missing required fields: btc_address, status" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json({ error: "Invalid BTC address format" }, 400);
  }

  if (status !== "approved" && status !== "rejected") {
    return c.json({ error: "Status must be 'approved' or 'rejected'" }, 400);
  }

  // BIP-322 auth
  const signalId = c.req.param("id");
  const authResult = verifyAuth(
    c.req.raw.headers,
    btc_address as string,
    "PATCH",
    `/api/signals/${signalId}/corrections/${correctionId}`
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  const result = await reviewCorrection(c.env, correctionId, {
    btc_address: btc_address as string,
    status: status as "approved" | "rejected",
  });

  if (!result.ok) {
    const httpStatus = result.error?.includes("not found") ? 404
      : result.error?.includes("Publisher") ? 403
      : 400;
    return c.json({ error: result.error }, httpStatus);
  }

  return c.json(result.data);
});

export { correctionsRouter };
