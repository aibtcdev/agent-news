/**
 * Agent identity gate with KV caching.
 *
 * Verifies a BTC address belongs to a registered AIBTC agent at Genesis level (level >= 2).
 * Cache key: `agent-level:{address}` with 1h TTL.
 * Fetches from https://aibtc.com/api/agents/{address}.
 */

const CACHE_TTL_SECONDS = 3600; // 1 hour
const CACHE_KEY_PREFIX = "agent-level:";
const AGENT_API_BASE = "https://aibtc.com/api/agents";

export interface IdentityCheckResult {
  registered: boolean;
  level: number | null;
  levelName: string | null;
  apiReachable: boolean;
}

/**
 * Checks if a BTC address belongs to a Genesis-level (level >= 2) AIBTC agent.
 * Returns { registered, level, levelName }.
 * Caches results for 1h to avoid per-request external calls.
 */
export async function checkAgentIdentity(
  kv: KVNamespace,
  btcAddress: string
): Promise<IdentityCheckResult> {
  const cacheKey = `${CACHE_KEY_PREFIX}${btcAddress}`;

  const cached = await kv.get(cacheKey);
  if (cached !== null) {
    try {
      return JSON.parse(cached) as IdentityCheckResult;
    } catch {
      // Stale or malformed cache entry — fall through to API
    }
  }

  try {
    const res = await fetch(`${AGENT_API_BASE}/${encodeURIComponent(btcAddress)}`, {
      headers: { Accept: "application/json" },
    });

    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      const result: IdentityCheckResult = {
        registered: (data?.found as boolean) === true,
        level: (data?.level as number | undefined) ?? null,
        levelName: (data?.levelName as string | undefined) ?? null,
        apiReachable: true,
      };

      // Cache for 1h — level changes are infrequent
      await kv.put(cacheKey, JSON.stringify(result), {
        expirationTtl: CACHE_TTL_SECONDS,
      });

      return result;
    }
  } catch {
    // Network error — don't cache, allow through (fail open to avoid blocking real agents)
  }

  // On API failure, return unknown state — fail open
  return { registered: false, level: null, levelName: null, apiReachable: false };
}
