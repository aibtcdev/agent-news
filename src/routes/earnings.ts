/**
 * Earnings route — correspondent earning history.
 *
 * GET   /api/earnings/unpaid    — aggregated unpaid earnings by correspondent (Publisher-only)
 * GET   /api/earnings/:address  — list earnings for a BTC address
 * PATCH /api/earnings/:id       — Publisher records sBTC txid after sending payout
 */

import { Hono } from "hono";
import type { Env, AppVariables, Earning } from "../lib/types";
import { validateBtcAddress } from "../lib/validators";
import { listEarnings, listUnpaidEarnings, updateEarning } from "../lib/do-client";
import { verifyAuth } from "../services/auth";

const earningsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/earnings/unpaid — aggregated unpaid earnings by correspondent (Publisher-only)
earningsRouter.get("/api/earnings/unpaid", async (c) => {
  const btcAddress = c.req.header("X-BTC-Address");
  if (!btcAddress) {
    return c.json(
      { error: "Missing authentication headers: X-BTC-Address, X-BTC-Signature, X-BTC-Timestamp", code: "MISSING_AUTH" },
      401
    );
  }

  // BIP-322 auth — Publisher must sign the request
  const authResult = verifyAuth(c.req.raw.headers, btcAddress, "GET", "/api/earnings/unpaid");
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  const result = await listUnpaidEarnings(c.env, btcAddress);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 403);
  }

  const unpaid = result.data ?? [];
  const totalUnpaidSats = unpaid.reduce((sum, row) => sum + row.total_unpaid_sats, 0);

  c.header("Cache-Control", "private, no-store");
  return c.json({
    unpaid,
    summary: {
      totalCorrespondents: unpaid.length,
      totalUnpaidSats: totalUnpaidSats,
    },
  });
});

// GET /api/earnings/:address — earning history for a correspondent
earningsRouter.get("/api/earnings/:address", async (c) => {
  const address = c.req.param("address");

  if (!validateBtcAddress(address)) {
    return c.json(
      { error: "Invalid BTC address (expected bech32 bc1... address)" },
      400
    );
  }

  let earnings: Earning[];
  try {
    earnings = await listEarnings(c.env, address);
  } catch {
    return c.json({ error: "Failed to fetch earnings" }, 503);
  }

  // Sum positive-amount earnings (brief inclusions, weekly prizes).
  // No paid/unpaid status field exists yet, so this is total earned, not "pending payout".
  const totalEarnedSats = earnings
    .filter((e) => e.amount_sats > 0)
    .reduce((sum, e) => sum + e.amount_sats, 0);

  c.header("Cache-Control", "public, max-age=30, s-maxage=60");
  return c.json({
    address,
    earnings,
    summary: {
      total: earnings.length,
      totalEarnedSats,
    },
  });
});

// PATCH /api/earnings/:id — Publisher records sBTC txid after sending payout
earningsRouter.patch("/api/earnings/:id", async (c) => {
  const id = c.req.param("id");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { btc_address, payout_txid } = body;

  if (!btc_address || typeof btc_address !== "string") {
    return c.json({ error: "Missing required field: btc_address" }, 400);
  }
  if (!payout_txid || typeof payout_txid !== "string" || payout_txid.trim() === "") {
    return c.json({ error: "Missing required field: payout_txid (non-empty string)" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json({ error: "Invalid BTC address format" }, 400);
  }

  // BIP-322 auth — Publisher must sign the request
  const authResult = verifyAuth(
    c.req.raw.headers,
    btc_address,
    "PATCH",
    `/api/earnings/${id}`
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  const result = await updateEarning(c.env, id, {
    btc_address,
    payout_txid: payout_txid.trim(),
  });

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  const logger = c.get("logger");
  logger.info("earning payout_txid recorded", {
    earning_id: id,
    payout_txid: payout_txid.trim(),
    publisher: btc_address,
  });

  return c.json(result.data as Earning);
});

export { earningsRouter };
