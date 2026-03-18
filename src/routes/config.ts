/**
 * Publisher designation and config management routes.
 *
 * POST /api/config/publisher — designate the Publisher (BIP-322 auth required)
 * GET  /api/config/publisher — get current Publisher address
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getConfig, setConfig } from "../lib/do-client";
import { validateBtcAddress } from "../lib/validators";
import { verifyAuth } from "../services/auth";
import { CONFIG_PUBLISHER_KEY } from "../lib/constants";

const configRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/config/publisher — get current Publisher address (public)
configRouter.get("/api/config/publisher", async (c) => {
  const config = await getConfig(c.env, CONFIG_PUBLISHER_KEY);
  if (!config) {
    return c.json({ error: "Publisher not yet designated" }, 404);
  }
  return c.json({
    publisher: config.value,
    designated_at: config.updated_at,
  });
});

// POST /api/config/publisher — designate a Publisher (BIP-322 auth required)
// If no Publisher is set, any BIP-322-authenticated agent can claim it (bootstrap).
// Once set, only the current Publisher can re-designate.
configRouter.post("/api/config/publisher", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { btc_address, publisher_address } = body;

  if (!btc_address) {
    return c.json({ error: "Missing required field: btc_address (caller)" }, 400);
  }
  if (!publisher_address) {
    return c.json({ error: "Missing required field: publisher_address (address to designate)" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json({ error: "Invalid btc_address format" }, 400);
  }
  if (!validateBtcAddress(publisher_address)) {
    return c.json({ error: "Invalid publisher_address format" }, 400);
  }

  // BIP-322 auth
  const authResult = verifyAuth(
    c.req.raw.headers,
    btc_address as string,
    "POST",
    "/api/config/publisher"
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  // Check if Publisher is already designated
  const current = await getConfig(c.env, CONFIG_PUBLISHER_KEY);
  if (current && current.value !== btc_address) {
    return c.json(
      { error: "Only the current Publisher can re-designate" },
      403
    );
  }

  const result = await setConfig(c.env, CONFIG_PUBLISHER_KEY, publisher_address as string);
  if (!result.ok) {
    return c.json({ error: result.error ?? "Failed to set publisher" }, 500);
  }

  const logger = c.get("logger");
  logger.info("publisher designated", {
    publisher: publisher_address,
    designated_by: btc_address,
  });

  return c.json({
    ok: true,
    message: "Publisher designated successfully.",
    publisher: publisher_address,
  });
});

export { configRouter };
