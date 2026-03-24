/**
 * ERC-8004 identity verification service.
 *
 * Resolves BTC addresses to ERC-8004 agent identities by querying the
 * identity-registry-v2 contract on Stacks mainnet via Hiro call-read-only API.
 * Results are cached in KV with a configurable TTL.
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
 * Returns the agent identity if verified, null if not registered or on API error.
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

  // Query the identity registry via Hiro call-read-only API.
  // get-agent-by-wallet takes a (string-ascii 62) argument.
  try {
    // Clarity string-ascii CV encoding:
    //   type_id  = 0x0d (1 byte)
    //   length   = 4-byte big-endian length of the string
    //   payload  = UTF-8 bytes of the string
    const bytes = Array.from(new TextEncoder().encode(btcAddress));
    const lenHex = bytes.length.toString(16).padStart(8, "0"); // 4-byte BE length
    const payloadHex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
    const clarityArg = `0x0d${lenHex}${payloadHex}`;

    const response = await fetch(
      `https://api.hiro.so/v2/contracts/call-read/${REGISTRY_ADDRESS}/${REGISTRY_NAME}/get-agent-by-wallet`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: REGISTRY_ADDRESS,
          arguments: [clarityArg],
        }),
      }
    );

    if (!response.ok) {
      // Contract call failed — don't cache, allow retry
      return null;
    }

    const data = (await response.json()) as { okay: boolean; result: string };

    if (!data.okay || !data.result || data.result.startsWith("0x09")) {
      // (none) response — agent not found. Cache negatives with shorter TTL.
      const negativeResult: AgentIdentity = {
        agentId: 0,
        btcAddress,
        verified: false,
        cachedAt: new Date().toISOString(),
      };
      await kv.put(cacheKey, JSON.stringify(negativeResult), {
        expirationTtl: Math.floor(ERC8004_CACHE_TTL_SECONDS / 4), // 15 min
      });
      return null;
    }

    // Parse (some ...) response — extract agent ID from optional uint.
    // Clarity optional uint: 0x0a (some) + 0x01 (uint type) + 16-byte big-endian uint.
    const agentId = parseInt(data.result.slice(6, 38), 16) || 0;

    const identity: AgentIdentity = {
      agentId,
      btcAddress,
      verified: true,
      cachedAt: new Date().toISOString(),
    };

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
