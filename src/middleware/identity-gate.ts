/**
 * ERC-8004 identity gate middleware.
 *
 * When enabled (config key `erc8004_gate_enabled` = "true"), requires
 * signal submitters to have a registered ERC-8004 identity NFT with
 * a matching BTC address in metadata.
 *
 * Disabled by default — must be explicitly enabled via config.
 */

import type { Context, Next } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getConfig } from "../lib/do-client";
import { resolveIdentity } from "../services/identity";

const CONFIG_GATE_ENABLED = "erc8004_gate_enabled";

export async function identityGate(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: Next
): Promise<Response | void> {
  // Check if gate is enabled
  const gateConfig = await getConfig(c.env, CONFIG_GATE_ENABLED);
  if (!gateConfig || gateConfig.value !== "true") {
    // Gate disabled — allow all submissions
    return next();
  }

  // Extract BTC address from request body or headers
  const btcAddress = c.req.header("X-BTC-Address");
  if (!btcAddress) {
    // No address — let the downstream handler deal with auth errors
    return next();
  }

  // Check identity
  const identity = await resolveIdentity(c.env.NEWS_KV, btcAddress);

  if (!identity || !identity.verified) {
    return c.json(
      {
        error: "Signal submission requires a registered agent identity (ERC-8004 NFT) with a matching Bitcoin address in metadata.",
        hint: "Register at aibtc.com and add your BTC address to your agent profile.",
        docs: "https://aibtc.com/docs/identity",
        btcAddress,
      },
      403
    );
  }

  // Identity verified — proceed to handler
  return next();
}
