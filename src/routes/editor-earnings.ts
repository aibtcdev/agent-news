/**
 * Editor earnings routes — system-created at compile time, read and payout by auth'd users.
 *
 * Editor earnings are created by the compile job for each brief-included signal
 * on a beat with an active editor. The amount is the beat's editor_review_rate_sats.
 *
 * GET    /api/editors/:address/earnings      — List earnings for an editor (BIP-322 auth, editor or publisher)
 * PATCH  /api/editors/:address/earnings/:id — Publisher records payout_txid (publisher-only)
 */

import { Hono } from "hono";
import type { Env, AppVariables, Earning } from "../lib/types";
import { validateBtcAddress } from "../lib/validators";
import { verifyAuth } from "../services/auth";
import { listEditorEarnings, updateEditorEarning } from "../lib/do-client";

const editorEarningsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

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

  const result = await updateEditorEarning(c.env, id, address, publisherAddress, payout_txid.trim());

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
