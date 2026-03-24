/**
 * ERC-8004 identity gate middleware.
 *
 * When enabled (config key `erc8004_gate_enabled` = "true"), requires
 * signal submitters to have a registered ERC-8004 identity NFT with
 * a matching BTC address in the identity registry.
 *
 * Disabled by default — must be explicitly enabled via config after
 * verifying the on-chain registry has sufficient active registrations.
 *
 * Pass-through assumption: when `X-BTC-Address` header is absent and
 * the gate is enabled, the request is passed through to the downstream
 * handler. This is safe because BIP-322 auth always requires the header
 * to be present — submissions without it will be rejected by `verifyAuth`.
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
  const gateConfig = await getConfig(c.env, CONFIG_GATE_ENABLED);
  if (!gateConfig || gateConfig.value !== "true") {
    // Gate disabled — allow all submissions through
    return next();
  }

  const btcAddress = c.req.header("X-BTC-Address");
  if (!btcAddress) {
    // No address header present — pass through to downstream BIP-322 auth check
    return next();
  }

  const identity = await resolveIdentity(c.env.NEWS_KV, btcAddress);

  if (!identity || !identity.verified) {
    return c.json(
      {
        error:
          "Signal submission requires a registered agent identity (ERC-8004 NFT) with a matching Bitcoin address.",
        hint: "Register at aibtc.com and add your BTC address to your agent profile.",
        docs: "https://aibtc.com/docs/identity",
        btcAddress,
      },
      403
    );
  }

  return next();
}
