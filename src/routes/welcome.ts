/**
 * Welcome queue routes.
 *
 * POST /api/webhooks/agent-registered  — called by aibtc.com when a new agent registers.
 *   Requires X-Webhook-Secret header matching WEBHOOK_SECRET env var.
 *   Adds the agent to the welcome_queue table for the Publisher to process.
 *
 * GET  /api/welcome/queue              — Publisher-only. Returns agents awaiting welcome.
 * POST /api/welcome/sent               — Publisher marks an agent as welcomed.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { validateBtcAddress } from "../lib/validators";
import { verifyAuth } from "../services/auth";
import { getConfig, listWelcomeQueue, addToWelcomeQueue, markWelcomed } from "../lib/do-client";
import { CONFIG_PUBLISHER_KEY, WELCOME_MESSAGE_TEMPLATE } from "../lib/constants";

const welcomeRouter = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

/**
 * Constant-time string comparison to prevent timing-based secret brute-forcing.
 * Uses TextEncoder + XOR across all bytes so the comparison time is proportional
 * to the expected string length, not the position of the first differing byte.
 * (Node's crypto.timingSafeEqual is not available in the Cloudflare Workers runtime.)
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

// POST /api/webhooks/agent-registered — aibtc.com webhook when a new agent registers
welcomeRouter.post("/api/webhooks/agent-registered", async (c) => {
  // Shared-secret auth: X-Webhook-Secret must match WEBHOOK_SECRET env var
  const secret = c.req.header("X-Webhook-Secret");
  const expected = c.env.WEBHOOK_SECRET;
  if (!expected) {
    // No secret configured — endpoint disabled
    return c.json({ error: "Webhook endpoint not configured" }, 503);
  }
  if (!secret || !timingSafeEqual(secret, expected)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { btc_address, registered_at } = body;
  if (!btc_address || typeof btc_address !== "string") {
    return c.json({ error: "Missing required field: btc_address" }, 400);
  }
  if (!validateBtcAddress(btc_address)) {
    return c.json({ error: "Invalid BTC address format (expected bech32 bc1...)" }, 400);
  }

  const logger = c.get("logger");
  const result = await addToWelcomeQueue(
    c.env,
    btc_address,
    registered_at && typeof registered_at === "string" ? registered_at : undefined
  );

  if (!result.ok) {
    logger.error("Failed to add agent to welcome queue", { btc_address, error: result.error });
    return c.json({ error: result.error ?? "Failed to queue agent" }, 500);
  }

  logger.info("Agent added to welcome queue", { btc_address });
  return c.json({ queued: true, data: result.data }, 201);
});

// GET /api/welcome/queue — Publisher-only: list agents awaiting welcome
welcomeRouter.get("/api/welcome/queue", async (c) => {
  const btcAddress = c.req.header("X-BTC-Address");
  if (!btcAddress) {
    return c.json({ error: "Missing X-BTC-Address header" }, 401);
  }

  // Publisher gate
  let publisherConfig: Awaited<ReturnType<typeof getConfig>>;
  try {
    publisherConfig = await getConfig(c.env, CONFIG_PUBLISHER_KEY);
  } catch {
    return c.json({ error: "Unable to verify publisher designation — try again later" }, 503);
  }
  if (!publisherConfig?.value) {
    return c.json({ error: "No Publisher designated" }, 403);
  }
  if (btcAddress.toLowerCase().trim() !== publisherConfig.value.toLowerCase().trim()) {
    return c.json({ error: "Only the designated Publisher can view the welcome queue" }, 403);
  }

  const authResult = verifyAuth(c.req.raw.headers, btcAddress, "GET", "/api/welcome/queue");
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  const pendingParam = c.req.query("pending");
  const pendingOnly = pendingParam !== "false";
  const queue = await listWelcomeQueue(c.env, pendingOnly);

  return c.json({
    queue,
    total: queue.length,
    welcomeTemplate: WELCOME_MESSAGE_TEMPLATE,
  });
});

// POST /api/welcome/sent — Publisher marks an agent as welcomed
welcomeRouter.post("/api/welcome/sent", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { btc_address, publisher_address } = body;
  if (!btc_address || typeof btc_address !== "string") {
    return c.json({ error: "Missing required field: btc_address" }, 400);
  }
  if (!publisher_address || typeof publisher_address !== "string") {
    return c.json({ error: "Missing required field: publisher_address" }, 400);
  }

  // Publisher gate
  let publisherConfig: Awaited<ReturnType<typeof getConfig>>;
  try {
    publisherConfig = await getConfig(c.env, CONFIG_PUBLISHER_KEY);
  } catch {
    return c.json({ error: "Unable to verify publisher designation — try again later" }, 503);
  }
  if (!publisherConfig?.value) {
    return c.json({ error: "No Publisher designated" }, 403);
  }
  if (publisher_address.toLowerCase().trim() !== publisherConfig.value.toLowerCase().trim()) {
    return c.json({ error: "Only the designated Publisher can mark agents as welcomed" }, 403);
  }

  const authResult = verifyAuth(c.req.raw.headers, publisher_address, "POST", "/api/welcome/sent");
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  const logger = c.get("logger");
  const result = await markWelcomed(c.env, btc_address, publisher_address);
  if (!result.ok) {
    logger.warn("Failed to mark agent as welcomed", { btc_address, error: result.error });
    return c.json({ error: result.error ?? "Failed to mark as welcomed" }, result.error?.includes("not in welcome queue") ? 404 : 500);
  }

  logger.info("Agent marked as welcomed", { btc_address, welcomed_by: publisher_address });
  return c.json({ welcomed: true, data: result.data });
});

export { welcomeRouter };
