/**
 * ERC-8004 identity gate middleware.
 *
 * When the `erc8004_gate_enabled` config key is set to `"true"`, this middleware
 * checks that the submitting agent has a valid ERC-8004 on-chain identity before
 * allowing the request through to the next handler.
 *
 * Gate is **disabled by default** — shipped in audit mode. Enable only after
 * verifying that the on-chain identity registry has active registrations (as of
 * March 2026, arc0btc confirmed zero on-chain activity on the registry).
 *
 * Missing-header pass-through assumption:
 *   If the `X-BTC-Address` header is absent, this middleware passes through without
 *   performing an ERC-8004 check. This is safe because `verifyAuth` (called downstream
 *   in the route handler) enforces BIP-322 authentication and explicitly requires the
 *   `X-BTC-Address` header — any request missing the header will be rejected with a
 *   401 MISSING_AUTH error before any state is mutated. The ERC-8004 gate therefore
 *   does not need to handle the no-header case independently.
 */

import type { Context, Next } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getConfig } from "../lib/do-client";
import { resolveIdentity } from "../services/identity";

const CONFIG_KEY_ERC8004_GATE = "erc8004_gate_enabled";

/**
 * Hono middleware that enforces ERC-8004 identity for signal submission.
 *
 * Behaviour matrix:
 * | gate enabled | X-BTC-Address header | identity on-chain | outcome         |
 * |:------------:|:--------------------:|:-----------------:|:----------------|
 * | false        | any                  | any               | pass-through    |
 * | true         | absent               | —                 | pass-through*   |
 * | true         | present              | registered        | pass-through    |
 * | true         | present              | not registered    | 403 blocked     |
 * | true         | present              | API unreachable   | pass-through**  |
 *
 * *  Downstream `verifyAuth` will reject with 401 MISSING_AUTH.
 * ** Fail open to avoid blocking real agents during transient Hiro API outages.
 */
export async function identityGateMiddleware(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: Next
// biome-ignore lint/suspicious/noConfusingVoidType: Hono middleware returns void from next()
): Promise<Response | void> {
  // Check if the gate is enabled via config key.
  // Disabled by default — zero risk to existing deployments on rollout.
  let gateEnabled = false;
  try {
    const configEntry = await getConfig(c.env, CONFIG_KEY_ERC8004_GATE);
    gateEnabled = configEntry?.value === "true";
  } catch {
    // Config fetch failed — treat as disabled (fail open)
    gateEnabled = false;
  }

  if (!gateEnabled) {
    // Audit mode: log whether the agent has an ERC-8004 identity without blocking.
    // This lets operators observe registration coverage before enabling the gate.
    const btcAddress = c.req.header("X-BTC-Address");
    if (btcAddress) {
      resolveIdentity(c.env.NEWS_KV, btcAddress)
        .then((identity) => {
          const logger = c.get("logger");
          logger.info("erc8004 audit (gate disabled)", {
            btc_address: btcAddress,
            registered: identity.registered,
            stacks_address: identity.stacksAddress,
            api_reachable: identity.apiReachable,
          });
        })
        .catch(() => {
          // Non-fatal: audit log failure should never block the request
        });
    }
    return next();
  }

  // Gate is enabled — perform the identity check.

  // See module-level comment: missing X-BTC-Address header passes through here
  // because verifyAuth downstream will reject it with 401 MISSING_AUTH.
  const btcAddress = c.req.header("X-BTC-Address");
  if (!btcAddress) {
    return next();
  }

  const identity = await resolveIdentity(c.env.NEWS_KV, btcAddress);

  // Fail open when the Hiro API is unreachable — avoid blocking real agents
  // during transient outages. Log the pass-through for observability.
  if (!identity.apiReachable) {
    const logger = c.get("logger");
    logger.warn("erc8004 gate: Hiro API unreachable — failing open", {
      btc_address: btcAddress,
    });
    return next();
  }

  if (!identity.registered) {
    const logger = c.get("logger");
    logger.warn("erc8004 gate: agent not registered — blocking", {
      btc_address: btcAddress,
    });
    return c.json(
      {
        error:
          "Signal submission requires an ERC-8004 on-chain agent identity. " +
          "Register your agent at https://aibtc.com to obtain an ERC-8004 NFT identity.",
        code: "ERC8004_IDENTITY_REQUIRED",
        docs: "https://aibtc.com/docs/identity",
      },
      403
    );
  }

  // Identity confirmed — log and allow through
  const logger = c.get("logger");
  logger.info("erc8004 gate: identity verified", {
    btc_address: btcAddress,
    stacks_address: identity.stacksAddress,
  });

  return next();
}
