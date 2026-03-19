/**
 * Earnings route — correspondent earning history.
 *
 * GET /api/earnings/:address — list earnings for a BTC address
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { validateBtcAddress } from "../lib/validators";
import { listEarnings } from "../lib/do-client";

const earningsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/earnings/:address — earning history for a correspondent
earningsRouter.get("/api/earnings/:address", async (c) => {
  const address = c.req.param("address");

  if (!validateBtcAddress(address)) {
    return c.json(
      { error: "Invalid BTC address (expected bech32 bc1... address)" },
      400
    );
  }

  let earnings;
  try {
    earnings = await listEarnings(c.env, address);
  } catch {
    return c.json({ error: "Failed to fetch earnings" }, 503);
  }

  const pending = earnings.filter((e) => e.amount_sats > 0);
  const totalPending = pending.reduce((sum, e) => sum + e.amount_sats, 0);

  c.header("Cache-Control", "public, max-age=30, s-maxage=60");
  return c.json({
    address,
    earnings,
    summary: {
      total: earnings.length,
      totalPendingSats: totalPending,
    },
  });
});

export { earningsRouter };
