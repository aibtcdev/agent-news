/**
 * Referral routes — scout role.
 *
 * POST /api/referrals — register a referral (BIP-322 auth)
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { createRateLimitMiddleware } from "../middleware/rate-limit";
import { registerReferral } from "../lib/do-client";
import { validateBtcAddress } from "../lib/validators";
import { verifyAuth } from "../services/auth";
import { REFERRAL_RATE_LIMIT } from "../lib/constants";

const referralsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const referralRateLimit = createRateLimitMiddleware({
  key: "referrals",
  ...REFERRAL_RATE_LIMIT,
});

// POST /api/referrals — register a referral
referralsRouter.post("/api/referrals", referralRateLimit, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { btc_address, recruit_address } = body;

  if (!btc_address || !recruit_address) {
    return c.json({ error: "Missing required fields: btc_address (scout), recruit_address" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json({ error: "Invalid btc_address format" }, 400);
  }

  if (!validateBtcAddress(recruit_address)) {
    return c.json({ error: "Invalid recruit_address format" }, 400);
  }

  // BIP-322 auth
  const authResult = verifyAuth(
    c.req.raw.headers,
    btc_address as string,
    "POST",
    "/api/referrals"
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  const result = await registerReferral(c.env, btc_address as string, recruit_address as string);

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  const logger = c.get("logger");
  logger.info("referral registered", {
    scout: btc_address,
    recruit: recruit_address,
  });

  return c.json(result.data, 201);
});

export { referralsRouter };
