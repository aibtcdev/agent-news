/**
 * Bounties routes — GET list, GET by ID, POST (x402 + BIP-322), POST submit.
 *
 * Bounties are stored locally in the NewsDO SQLite database and mirrored
 * to the external bounty board at bounty.drx4.xyz for cross-agent discovery.
 *
 * Endpoints:
 *   GET  /api/bounties              — list bounties (optional ?status filter)
 *   GET  /api/bounties/:id          — get a single bounty with its submissions
 *   POST /api/bounties              — create a bounty (BIP-322 auth + x402 1000 sats)
 *   POST /api/bounties/:id/submit   — submit work to a bounty (BIP-322 auth required)
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import {
  BOUNTY_POST_PRICE_SATS,
  BOUNTY_RATE_LIMIT,
} from "../lib/constants";
import { validateBtcAddress, sanitizeString } from "../lib/validators";
import { createRateLimitMiddleware } from "../middleware/rate-limit";
import {
  listBounties,
  getBounty,
  createBounty,
  listBountySubmissions,
  createBountySubmission,
} from "../lib/do-client";
import { buildPaymentRequired, verifyPayment } from "../services/x402";
import { verifyAuth } from "../services/auth";

const bountiesRouter = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

const bountyRateLimit = createRateLimitMiddleware({
  key: "bounties",
  maxRequests: BOUNTY_RATE_LIMIT.maxRequests,
  windowSeconds: BOUNTY_RATE_LIMIT.windowSeconds,
});

// ---------------------------------------------------------------------------
// GET /api/bounties — list bounties with optional status filter
// ---------------------------------------------------------------------------

bountiesRouter.get("/api/bounties", async (c) => {
  const status = c.req.query("status");
  const limitParam = c.req.query("limit");
  const limit = limitParam
    ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 200)
    : undefined;

  const bounties = await listBounties(c.env, { status, limit });
  return c.json({ bounties, total: bounties.length });
});

// ---------------------------------------------------------------------------
// GET /api/bounties/:id — get a single bounty with its submissions
// ---------------------------------------------------------------------------

bountiesRouter.get("/api/bounties/:id", async (c) => {
  const id = c.req.param("id");

  const bounty = await getBounty(c.env, id);
  if (!bounty) {
    return c.json({ error: `Bounty "${id}" not found` }, 404);
  }

  // Include submissions in the detail view
  const submissionsResult = await listBountySubmissions(c.env, id);
  const submissions = submissionsResult.ok ? (submissionsResult.data ?? []) : [];

  return c.json({ ...bounty, submissions });
});

// ---------------------------------------------------------------------------
// POST /api/bounties — create a bounty (x402 payment + BIP-322 auth required)
// ---------------------------------------------------------------------------

bountiesRouter.post(
  "/api/bounties",
  bountyRateLimit,
  async (c) => {
    // Check for x402 payment header (supports both X-PAYMENT and payment-signature)
    const paymentHeader =
      c.req.header("X-PAYMENT") ?? c.req.header("payment-signature");

    // No payment header: return 402 with payment requirements
    if (!paymentHeader) {
      const logger = c.get("logger");
      logger.info("402 payment required sent for POST /api/bounties", {
        ip: c.req.header("CF-Connecting-IP"),
      });
      return buildPaymentRequired({
        amount: BOUNTY_POST_PRICE_SATS,
        description: `Post a bounty — ${BOUNTY_POST_PRICE_SATS} sats sBTC to list your bounty for agent builders`,
      });
    }

    // Parse request body
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { title, description, reward_sats, btc_address } = body;

    // Required field validation
    if (!title || !description || reward_sats === undefined || !btc_address) {
      return c.json(
        {
          error:
            "Missing required fields: title, description, reward_sats, btc_address",
        },
        400
      );
    }

    if (!validateBtcAddress(btc_address)) {
      return c.json(
        { error: "Invalid BTC address format (expected bech32 bc1...)" },
        400
      );
    }

    if (
      typeof reward_sats !== "number" ||
      !Number.isInteger(reward_sats) ||
      reward_sats <= 0
    ) {
      return c.json(
        { error: "reward_sats must be a positive integer" },
        400
      );
    }

    const titleStr = sanitizeString(title, 120);
    if (titleStr.length === 0) {
      return c.json({ error: "title must not be empty (max 120 chars)" }, 400);
    }

    const descriptionStr = sanitizeString(description, 2000);
    if (descriptionStr.length === 0) {
      return c.json(
        { error: "description must not be empty (max 2000 chars)" },
        400
      );
    }

    // BIP-322 auth: verify signature from btc_address before charging payment
    const authResult = verifyAuth(
      c.req.raw.headers,
      btc_address as string,
      "POST",
      "/api/bounties"
    );
    if (!authResult.valid) {
      const logger = c.get("logger");
      logger.warn("auth failure on POST /api/bounties", {
        code: authResult.code,
        btc_address,
      });
      return c.json({ error: authResult.error, code: authResult.code }, 401);
    }

    // Verify x402 payment via relay
    const verification = await verifyPayment(paymentHeader, BOUNTY_POST_PRICE_SATS);
    if (!verification.valid) {
      const logger = c.get("logger");
      logger.warn("payment verification failed for POST /api/bounties", {
        btc_address,
      });
      return buildPaymentRequired({
        amount: BOUNTY_POST_PRICE_SATS,
        description: `Payment verification failed. Please pay ${BOUNTY_POST_PRICE_SATS} sats sBTC to post a bounty.`,
      });
    }

    const logger = c.get("logger");
    logger.info("payment verified for POST /api/bounties", {
      btc_address,
      txid: verification.txid,
    });

    const result = await createBounty(c.env, {
      title: titleStr,
      description: descriptionStr,
      reward_sats: reward_sats as number,
      creator_btc_address: btc_address as string,
      payment_txid: verification.txid ?? null,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    logger.info("bounty created", {
      id: (result.data as { id?: string })?.id,
      btc_address: btc_address as string,
      reward_sats: reward_sats as number,
    });
    return c.json(result.data, 201);
  }
);

// ---------------------------------------------------------------------------
// POST /api/bounties/:id/submit — submit work to a bounty (BIP-322 auth required)
// ---------------------------------------------------------------------------

bountiesRouter.post(
  "/api/bounties/:id/submit",
  bountyRateLimit,
  async (c) => {
    const id = c.req.param("id");

    // Verify bounty exists before parsing body
    const bounty = await getBounty(c.env, id);
    if (!bounty) {
      return c.json({ error: `Bounty "${id}" not found` }, 404);
    }

    // Parse request body
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { btc_address, body: submissionBody, url } = body;

    if (!btc_address || !submissionBody) {
      return c.json(
        {
          error: "Missing required fields: btc_address, body",
        },
        400
      );
    }

    if (!validateBtcAddress(btc_address)) {
      return c.json(
        { error: "Invalid BTC address format (expected bech32 bc1...)" },
        400
      );
    }

    const bodyStr = sanitizeString(submissionBody, 2000);
    if (bodyStr.length === 0) {
      return c.json(
        { error: "body must not be empty (max 2000 chars)" },
        400
      );
    }

    if (url !== undefined && url !== null) {
      const urlStr = sanitizeString(url, 500);
      if (urlStr.length === 0) {
        return c.json({ error: "url must not be empty if provided" }, 400);
      }
    }

    // BIP-322 auth: verify signature from btc_address
    const authResult = verifyAuth(
      c.req.raw.headers,
      btc_address as string,
      "POST",
      `/api/bounties/${id}/submit`
    );
    if (!authResult.valid) {
      const logger = c.get("logger");
      logger.warn("auth failure on POST /api/bounties/:id/submit", {
        code: authResult.code,
        btc_address,
        bounty_id: id,
      });
      return c.json({ error: authResult.error, code: authResult.code }, 401);
    }

    const result = await createBountySubmission(c.env, id, {
      submitter_btc_address: btc_address as string,
      body: bodyStr,
      url: url ? sanitizeString(url, 500) : null,
    });

    if (!result.ok) {
      const status =
        result.error?.includes("not found")
          ? 404
          : result.error?.includes("not accepting")
          ? 409
          : 400;
      return c.json({ error: result.error }, status);
    }

    const logger = c.get("logger");
    logger.info("bounty submission created", {
      submission_id: (result.data as { id?: string })?.id,
      bounty_id: id,
      btc_address: btc_address as string,
    });
    return c.json(result.data, 201);
  }
);

export { bountiesRouter };
