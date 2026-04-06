/**
 * Editor earnings routes — beat editor self-reported review payouts.
 *
 * POST   /api/editors/:address/earnings      — Editor self-reports an earning (BIP-322 auth)
 * GET    /api/editors/:address/earnings      — List earnings for an editor (BIP-322 auth, editor or publisher)
 * PATCH  /api/editors/:address/earnings/:id — Publisher records payout_txid (publisher-only)
 */

import { Hono } from "hono";
import type { Env, AppVariables, Earning } from "../lib/types";
import { validateBtcAddress } from "../lib/validators";
import { verifyAuth } from "../services/auth";
import { recordEditorEarning, listEditorEarnings, updateEditorEarning } from "../lib/do-client";

const editorEarningsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// POST /api/editors/:address/earnings — Editor self-reports an earning
editorEarningsRouter.post("/api/editors/:address/earnings", async (c) => {
  const address = c.req.param("address");

  if (!validateBtcAddress(address)) {
    return c.json({ error: "Invalid BTC address in path" }, 400);
  }

  // BIP-322 auth — the signer must be the editor address in the path
  const signerAddress = c.req.header("X-BTC-Address");
  if (!signerAddress) {
    return c.json(
      { error: "Missing authentication headers: X-BTC-Address, X-BTC-Signature, X-BTC-Timestamp", code: "MISSING_AUTH" },
      401
    );
  }
  if (signerAddress !== address) {
    return c.json({ error: "X-BTC-Address must match the editor address in the path" }, 403);
  }

  const authResult = verifyAuth(
    c.req.raw.headers,
    address,
    "POST",
    `/api/editors/${address}/earnings`
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { beat_slug, amount_sats, reason, signal_id } = body;
  if (!beat_slug || !amount_sats || !reason) {
    return c.json({ error: "Missing required fields: beat_slug, amount_sats, reason" }, 400);
  }
  if (typeof amount_sats !== "number" || amount_sats <= 0 || !Number.isInteger(amount_sats)) {
    return c.json({ error: "amount_sats must be a positive integer" }, 400);
  }

  const result = await recordEditorEarning(c.env, address, {
    beat_slug: beat_slug as string,
    amount_sats: amount_sats as number,
    reason: reason as string,
    signal_id: signal_id ? String(signal_id) : null,
  });

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  const logger = c.get("logger");
  logger.info("editor earning recorded", {
    editor: address,
    beat_slug,
    amount_sats,
    reason,
    signal_id: signal_id ?? null,
  });

  return c.json(result.data as Earning, 201);
});

// GET /api/editors/:address/earnings — List earnings for an editor (editor or publisher)
editorEarningsRouter.get("/api/editors/:address/earnings", async (c) => {
  const address = c.req.param("address");

  if (!validateBtcAddress(address)) {
    return c.json({ error: "Invalid BTC address in path" }, 400);
  }

  const callerAddress = c.req.header("X-BTC-Address");
  if (!callerAddress) {
    return c.json(
      { error: "Missing authentication headers: X-BTC-Address, X-BTC-Signature, X-BTC-Timestamp", code: "MISSING_AUTH" },
      401
    );
  }
  if (!validateBtcAddress(callerAddress)) {
    return c.json({ error: "Invalid BTC address in X-BTC-Address header" }, 400);
  }

  const authResult = verifyAuth(
    c.req.raw.headers,
    callerAddress,
    "GET",
    `/api/editors/${address}/earnings`
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  const result = await listEditorEarnings(c.env, address, callerAddress);

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  const earnings = result.data ?? [];
  const totalEarnedSats = earnings
    .filter((e) => e.amount_sats > 0)
    .reduce((sum, e) => sum + e.amount_sats, 0);

  c.header("Cache-Control", "private, no-store");
  return c.json({
    address,
    earnings,
    summary: {
      total: earnings.length,
      totalEarnedSats,
    },
  });
});

// PATCH /api/editors/:address/earnings/:id — Publisher records payout_txid
editorEarningsRouter.patch("/api/editors/:address/earnings/:id", async (c) => {
  const address = c.req.param("address");
  const id = c.req.param("id");

  if (!validateBtcAddress(address)) {
    return c.json({ error: "Invalid BTC address in path" }, 400);
  }

  const publisherAddress = c.req.header("X-BTC-Address");
  if (!publisherAddress) {
    return c.json(
      { error: "Missing authentication headers: X-BTC-Address, X-BTC-Signature, X-BTC-Timestamp", code: "MISSING_AUTH" },
      401
    );
  }
  if (!validateBtcAddress(publisherAddress)) {
    return c.json({ error: "Invalid BTC address in X-BTC-Address header" }, 400);
  }

  const authResult = verifyAuth(
    c.req.raw.headers,
    publisherAddress,
    "PATCH",
    `/api/editors/${address}/earnings/${id}`
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { payout_txid } = body;
  if (!payout_txid || typeof payout_txid !== "string" || payout_txid.trim() === "") {
    return c.json({ error: "Missing required field: payout_txid (non-empty string)" }, 400);
  }

  const result = await updateEditorEarning(c.env, id, publisherAddress, payout_txid.trim());

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  const logger = c.get("logger");
  logger.info("editor earning payout_txid recorded", {
    earning_id: id,
    editor: address,
    payout_txid: payout_txid.trim(),
    publisher: publisherAddress,
  });

  return c.json(result.data as Earning);
});

export { editorEarningsRouter };
