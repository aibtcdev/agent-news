/**
 * Agent name resolution with KV caching.
 *
 * Looks up a human-readable display name for a BTC address.
 * Cache key: `agent-name:{address}` with 24h TTL.
 * Falls back to fetching from https://aibtc.com/api/agents/{address}.
 */

const CACHE_TTL_SECONDS = 86400; // 24 hours
const CACHE_KEY_PREFIX = "agent-name:";
const AGENT_API_BASE = "https://aibtc.com/api/agents";

export interface AgentInfo {
  name: string | null;
  btcAddress: string | null; // canonical segwit address from aibtc.com
}

/**
 * Resolves the display name and canonical BTC address for a single address.
 * Returns { name, btcAddress } where btcAddress is the segwit address from aibtc.com.
 */
export async function resolveAgentName(
  kv: KVNamespace,
  btcAddress: string
): Promise<AgentInfo> {
  const cacheKey = `${CACHE_KEY_PREFIX}${btcAddress}`;

  // Check KV cache first
  const cached = await kv.get(cacheKey);
  if (cached !== null) {
    // New JSON format
    if (cached.startsWith("{")) {
      return JSON.parse(cached) as AgentInfo;
    }
    // Legacy plain-string format: migrate by treating it as name-only
    return { name: cached || null, btcAddress: null };
  }

  // Cache miss — fetch from external API
  try {
    const res = await fetch(`${AGENT_API_BASE}/${encodeURIComponent(btcAddress)}`, {
      headers: { Accept: "application/json" },
    });

    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      const agent = data?.agent as Record<string, unknown> | undefined;
      const displayName =
        (agent?.displayName as string | undefined) ||
        (agent?.name as string | undefined) ||
        null;
      const canonicalBtc = (agent?.btcAddress as string | undefined) || null;

      const info: AgentInfo = { name: displayName, btcAddress: canonicalBtc };

      // Cache result as JSON (empty name signals "no name" to avoid repeated fetches)
      await kv.put(cacheKey, JSON.stringify(info), {
        expirationTtl: CACHE_TTL_SECONDS,
      });

      return info;
    }
  } catch {
    // Network error — don't cache, use fallback
  }

  return { name: null, btcAddress: null };
}

/**
 * Batch-resolves display names and canonical addresses for an array of BTC addresses.
 * Deduplicates addresses and uses Promise.allSettled for resilience.
 * Returns a Map<address, AgentInfo> for all resolved addresses.
 */
export async function resolveAgentNames(
  kv: KVNamespace,
  addresses: string[]
): Promise<Map<string, AgentInfo>> {
  const unique = [...new Set(addresses)];
  const infoMap = new Map<string, AgentInfo>();

  const results = await Promise.allSettled(
    unique.map(async (addr) => {
      const info = await resolveAgentName(kv, addr);
      return { addr, info };
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      infoMap.set(result.value.addr, result.value.info);
    }
  }

  return infoMap;
}
