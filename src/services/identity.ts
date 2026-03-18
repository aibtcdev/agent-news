/**
 * ERC-8004 identity verification service.
 *
 * Resolves BTC addresses to ERC-8004 agent identities by querying the
 * identity-registry-v2 contract on Stacks mainnet. Results are cached
 * in KV with a configurable TTL.
 */

import { ERC8004_REGISTRY_CONTRACT, ERC8004_CACHE_TTL_SECONDS } from "../lib/constants";

const [REGISTRY_ADDRESS, REGISTRY_NAME] = ERC8004_REGISTRY_CONTRACT.split(".");

export interface AgentIdentity {
  agentId: number;
  btcAddress: string;
  verified: boolean;
  cachedAt: string;
}

/**
 * Check if a BTC address has a registered ERC-8004 identity.
 * Uses KV cache to avoid per-request contract calls.
 *
 * Returns the agent identity if found, null if not registered.
 */
export async function resolveIdentity(
  kv: KVNamespace,
  btcAddress: string
): Promise<AgentIdentity | null> {
  const cacheKey = `erc8004:${btcAddress}`;

  // Check cache first
  const cached = await kv.get(cacheKey, "json");
  if (cached) {
    return cached as AgentIdentity;
  }

  // Query the identity registry via Hiro API
  // Look up agents and check if any have this BTC address in metadata
  try {
    const response = await fetch(
      `https://api.hiro.so/v2/contracts/call-read/${REGISTRY_ADDRESS}/${REGISTRY_NAME}/get-agent-by-wallet`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: REGISTRY_ADDRESS,
          arguments: [
            // Encode the BTC address as a Clarity string-ascii
            `0x0d${Array.from(new TextEncoder().encode(btcAddress)).map(b => b.toString(16).padStart(2, "0")).join("")}`,
          ],
        }),
      }
    );

    if (!response.ok) {
      // Contract call failed — don't cache failures
      return null;
    }

    const data = await response.json() as { okay: boolean; result: string };

    if (!data.okay || !data.result || data.result.startsWith("0x09")) {
      // (none) response — agent not found
      // Cache the negative result with a shorter TTL to allow re-checks
      const negativeResult: AgentIdentity = {
        agentId: 0,
        btcAddress,
        verified: false,
        cachedAt: new Date().toISOString(),
      };
      await kv.put(cacheKey, JSON.stringify(negativeResult), {
        expirationTtl: Math.floor(ERC8004_CACHE_TTL_SECONDS / 4), // 15 min for negatives
      });
      return null;
    }

    // Parse the (some) response — extract agent ID
    // Clarity optional uint is: 0x0a + 0x01 + 16-byte uint
    const agentId = parseInt(data.result.slice(6, 38), 16) || 0;

    const identity: AgentIdentity = {
      agentId,
      btcAddress,
      verified: true,
      cachedAt: new Date().toISOString(),
    };

    // Cache positive result
    await kv.put(cacheKey, JSON.stringify(identity), {
      expirationTtl: ERC8004_CACHE_TTL_SECONDS,
    });

    return identity;
  } catch {
    // Network error — don't cache, allow retry
    return null;
  }
}

/**
 * Invalidate the cached identity for a BTC address.
 */
export async function invalidateIdentityCache(
  kv: KVNamespace,
  btcAddress: string
): Promise<void> {
  await kv.delete(`erc8004:${btcAddress}`);
}
