/**
 * Corrections routes — fact-checker role.
 *
 * GET   /api/corrections                           — list all corrections by status (Publisher-only)
 * POST  /api/signals/:id/corrections              — file a correction (BIP-322 auth)
 * GET   /api/signals/:id/corrections              — list corrections on a signal
 * PATCH /api/signals/:id/corrections/:correctionId — Publisher reviews correction
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { createRateLimitMiddleware } from "../middleware/rate-limit";
import { createCorrection, listCorrections, listAllCorrections, reviewCorrection } from "../lib/do-client";
import { validateBtcAddress } from "../lib/validators";
import { verifyAuth } from "../services/auth";
import { CORRECTION_RATE_LIMIT } from "../lib/constants";

const correctionsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const correctionRateLimit = createRateLimitMiddleware({
  key: "corrections",
  ...CORRECTION_RATE_LIMIT,
});

// GET /api/corrections — list all corrections, optionally filtered by status (Publisher-only)
correctionsRouter.get("/api/corrections", async (c) => {
  const btcAddress = c.req.header("X-BTC-Address");
  if (!btcAddress) {
    return c.json(
      { error: "Missing authentication headers: X-BTC-Address, X-BTC-Signature, X-BTC-Timestamp", code: "MISSING_AUTH" },
      401
    );
  }

  // BIP-322 auth — Publisher must sign the request
  const authResult = verifyAuth(c.req.raw.headers, btcAddress, "GET", "/api/corrections");
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  const status = c.req.query("status");
  const result = await listAllCorrections(c.env, btcAddress, status);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 403);
  }

  const corrections = result.data ?? [];
  c.header("Cache-Control", "private, no-store");
  return c.json({ corrections, total: corrections.length });
});

// POST /api/signals/:id/corrections — file a correction or editorial review
correctionsRouter.post("/api/signals/:id/corrections", correctionRateLimit, async (c) => {
  const signalId = c.req.param("id");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { btc_address, type } = body;
  const entryType = (type as string | undefined) ?? "correction";

  if (!btc_address) {
    return c.json({ error: "Missing required field: btc_address" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json({ error: "Invalid BTC address format" }, 400);
  }

  if (entryType !== "correction" && entryType !== "editorial_review") {
    return c.json({ error: "Invalid type. Must be 'correction' or 'editorial_review'" }, 400);
  }

  // Validate type-specific required fields at the route level
  if (entryType === "correction") {
    const { claim, correction } = body;
    if (typeof claim !== "string" || claim.trim().length === 0) {
      return c.json({ error: "claim must be a non-empty string" }, 400);
    }
    if (typeof correction !== "string" || correction.trim().length === 0) {
      return c.json({ error: "correction must be a non-empty string" }, 400);
    }
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

  // Build input — pass all fields through; the DO validates and sanitizes
  const input: Parameters<typeof createCorrection>[1] = {
    signal_id: signalId as string,
    btc_address: btc_address as string,
    type: entryType as "correction" | "editorial_review",
  };

  if (entryType === "correction") {
    input.claim = body.claim as string;
    input.correction = body.correction as string;
    input.sources = body.sources ? String(body.sources) : null;
  } else {
    // Editorial review fields — DO handles validation
    if (body.score !== undefined) input.score = body.score as number;
    if (body.factcheck_passed !== undefined) input.factcheck_passed = body.factcheck_passed as boolean;
    if (body.beat_relevance !== undefined) input.beat_relevance = body.beat_relevance as number;
    if (body.recommendation !== undefined) input.recommendation = body.recommendation as string;
    if (body.feedback !== undefined) input.feedback = body.feedback as string;
  }

  const result = await createCorrection(c.env, input);

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  const logger = c.get("logger");
  logger.info(`${entryType} filed`, {
    signal_id: signalId,
    type: entryType,
    filer: btc_address,
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
    return c.json({ error: result.error }, result.status ?? 400);
  }

  return c.json(result.data);
});

export { correctionsRouter };
