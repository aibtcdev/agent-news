/**
 * Payout routes — Publisher executes correspondent payouts.
 *
 * POST /api/payouts/record — record brief inclusion earnings (Publisher-only)
 * GET  /api/earnings/:address — correspondent checks their earnings
 * POST /api/payouts/mark-paid — mark earnings as paid with tx_id (Publisher-only)
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { createRateLimitMiddleware } from "../middleware/rate-limit";
import {
  getConfig,
  recordEarning,
  getBriefSignals,
  listEarnings,
} from "../lib/do-client";
import { validateBtcAddress } from "../lib/validators";
import { verifyAuth } from "../services/auth";
import {
  PAYOUT_RATE_LIMIT,
  CONFIG_PUBLISHER_KEY,
  CONFIG_BRIEF_INCLUSION_RATE,
  DEFAULT_BRIEF_INCLUSION_RATE,
} from "../lib/constants";

const payoutsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const payoutRateLimit = createRateLimitMiddleware({
  key: "payouts",
  maxRequests: PAYOUT_RATE_LIMIT.maxRequests,
  windowSeconds: PAYOUT_RATE_LIMIT.windowSeconds,
});

// POST /api/payouts/record — record brief inclusion earnings for a date (Publisher-only)
payoutsRouter.post("/api/payouts/record", payoutRateLimit, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { btc_address, brief_date } = body;

  if (!btc_address || !brief_date) {
    return c.json({ error: "Missing required fields: btc_address, brief_date" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json({ error: "Invalid BTC address format" }, 400);
  }

  // BIP-322 auth
  const authResult = verifyAuth(
    c.req.raw.headers,
    btc_address as string,
    "POST",
    "/api/payouts/record"
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  // Verify publisher
  const publisherConfig = await getConfig(c.env, CONFIG_PUBLISHER_KEY);
  if (!publisherConfig || publisherConfig.value !== btc_address) {
    return c.json({ error: "Only the designated Publisher can record payouts" }, 403);
  }

  // Get configured payout rate (or default)
  const rateConfig = await getConfig(c.env, CONFIG_BRIEF_INCLUSION_RATE);
  const rateSats = rateConfig ? parseInt(rateConfig.value, 10) : DEFAULT_BRIEF_INCLUSION_RATE;

  // Get signals included in this brief
  const briefSignals = await getBriefSignals(c.env, brief_date as string);

  if (!briefSignals || briefSignals.length === 0) {
    return c.json({ error: `No signals found in brief for ${brief_date}` }, 404);
  }

  // Record earnings for each correspondent
  const recorded = [];
  for (const sig of briefSignals) {
    const s = sig as Record<string, unknown>;
    const result = await recordEarning(c.env, {
      btc_address: s.btc_address as string,
      amount_sats: rateSats,
      reason: "brief_inclusion",
      reference_id: s.signal_id as string,
    });
    if (result.ok) {
      recorded.push(result.data);
    }
  }

  const logger = c.get("logger");
  logger.info("brief earnings recorded", {
    brief_date,
    count: recorded.length,
    rate_sats: rateSats,
  });

  return c.json({
    ok: true,
    brief_date,
    earnings_recorded: recorded.length,
    rate_sats: rateSats,
    total_sats: recorded.length * rateSats,
  }, 201);
});

// GET /api/earnings/:address — correspondent checks their earnings
payoutsRouter.get("/api/earnings/:address", async (c) => {
  const address = c.req.param("address") as string;

  if (!validateBtcAddress(address)) {
    return c.json({ error: "Invalid BTC address format" }, 400);
  }

  const earnings = await listEarnings(c.env, address);

  // Compute summary
  let totalPending = 0;
  let totalPaid = 0;
  let countPending = 0;
  let countPaid = 0;

  for (const e of earnings) {
    if (e.status === "pending") {
      totalPending += e.amount_sats;
      countPending++;
    } else if (e.status === "paid") {
      totalPaid += e.amount_sats;
      countPaid++;
    }
  }

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({
    address,
    earnings: earnings.map((e) => ({
      id: e.id,
      amount_sats: e.amount_sats,
      reason: e.reason,
      status: e.status,
      tx_id: e.tx_id,
      created_at: e.created_at,
    })),
    summary: {
      pending: { count: countPending, total_sats: totalPending },
      paid: { count: countPaid, total_sats: totalPaid },
      total_earned: totalPending + totalPaid,
    },
  });
});

export { payoutsRouter };
