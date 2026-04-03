/**
 * Agent name resolution with KV caching.
 *
 * Looks up human-readable display names for BTC addresses.
 * Cache key: `agent-name:{address}` with 24h TTL.
 *
 * Single lookups fall back to the individual endpoint.
 * Batch lookups use the paginated list endpoint (~0.3s for 100 agents)
 * instead of N individual calls (~42s each).
 */

const CACHE_TTL_SECONDS = 86400; // 24 hours
const CACHE_KEY_PREFIX = "agent-name:";
const AGENT_API_BASE = "https://aibtc.com/api/agents";
const BULK_PAGE_SIZE = 100; // max allowed by aibtc.com
const BULK_MAX_PAGES = 10; // safety cap: 1000 agents max

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
  btcAddress: string,
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

  // Cache miss — fetch from external API with 5-second timeout
  try {
    const res = await fetch(
      `${AGENT_API_BASE}/${encodeURIComponent(btcAddress)}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      },
    );

    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      const agent = data?.agent as Record<string, unknown> | undefined;
      const displayName =
        (agent?.displayName as string | undefined) ||
        (agent?.name as string | undefined) ||
        null;
      const canonicalBtc =
        (agent?.btcAddress as string | undefined) || null;

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

interface BulkFetchResult {
  agents: Map<string, AgentInfo>;
  /** True only when all pages were fetched successfully (no errors, no truncation). */
  complete: boolean;
}

/**
 * Fetch all agents from the paginated bulk list endpoint.
 * Returns a Map<btcAddress, AgentInfo> for every agent in the registry,
 * plus a `complete` flag indicating whether the full list was fetched.
 * Much faster than individual lookups: ~0.3s per 100 agents vs ~42s per individual call.
 */
async function fetchBulkAgents(): Promise<BulkFetchResult> {
  const allAgents = new Map<string, AgentInfo>();
  let offset = 0;
  let complete = false;

  for (let page = 0; page < BULK_MAX_PAGES; page++) {
    try {
      const res = await fetch(
        `${AGENT_API_BASE}?limit=${BULK_PAGE_SIZE}&offset=${offset}`,
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10000),
        },
      );

      if (!res.ok) break;

      const data = (await res.json()) as {
        agents: Array<Record<string, unknown>>;
        pagination?: { hasMore?: boolean };
      };

      for (const agent of data.agents) {
        const btcAddr = agent.btcAddress as string | undefined;
        if (!btcAddr) continue;

        const displayName =
          (agent.displayName as string | undefined) ||
          (agent.name as string | undefined) ||
          null;

        allAgents.set(btcAddr, {
          name: displayName,
          btcAddress: btcAddr,
        });
      }

      if (!data.pagination?.hasMore) {
        complete = true;
        break;
      }
      offset += BULK_PAGE_SIZE;
    } catch {
      // Network error on this page — return what we have so far
      break;
    }
  }

  return { agents: allAgents, complete };
}

/**
 * Batch-resolves display names and canonical addresses for an array of BTC addresses.
 *
 * Strategy:
 * 1. Check KV cache for all requested addresses
 * 2. If there are cache misses, fetch the bulk agent list (~0.3s for 100 agents)
 *    instead of making N individual calls (~42s each)
 * 3. Populate KV cache for ALL fetched agents (pre-warms future requests)
 * 4. Return a Map<address, AgentInfo> for all requested addresses
 */
export async function resolveAgentNames(
  kv: KVNamespace,
  addresses: string[],
): Promise<Map<string, AgentInfo>> {
  const unique = [...new Set(addresses)];
  const infoMap = new Map<string, AgentInfo>();
  const uncached: string[] = [];

  // Step 1: Check KV cache for all addresses in parallel
  const cacheResults = await Promise.allSettled(
    unique.map(async (addr) => {
      const cached = await kv.get(`${CACHE_KEY_PREFIX}${addr}`);
      return { addr, cached };
    }),
  );

  for (const result of cacheResults) {
    if (result.status !== "fulfilled") continue;
    const { addr, cached } = result.value;

    if (cached !== null) {
      if (cached.startsWith("{")) {
        infoMap.set(addr, JSON.parse(cached) as AgentInfo);
      } else {
        infoMap.set(addr, { name: cached || null, btcAddress: null });
      }
    } else {
      uncached.push(addr);
    }
  }

  // Step 2: If all addresses were cached, return immediately
  if (uncached.length === 0) return infoMap;

  // Step 3: Fetch bulk agent list and match against uncached addresses
  const { agents: bulkAgents, complete } = await fetchBulkAgents();
  const uncachedSet = new Set(uncached);

  // Step 4: Populate KV cache for ALL fetched agents (pre-warm) and resolve our addresses
  const kvWrites: Promise<void>[] = [];

  for (const [btcAddr, info] of bulkAgents) {
    const cacheKey = `${CACHE_KEY_PREFIX}${btcAddr}`;
    kvWrites.push(
      kv.put(cacheKey, JSON.stringify(info), {
        expirationTtl: CACHE_TTL_SECONDS,
      }),
    );

    if (uncachedSet.has(btcAddr)) {
      infoMap.set(btcAddr, info);
      uncachedSet.delete(btcAddr);
    }
  }

  // Only negative-cache addresses as "not found" when the bulk fetch completed fully.
  // A partial fetch (network error, pagination cap) might have missed real agents,
  // and we don't want to incorrectly cache them as absent for 24 hours.
  if (complete) {
    for (const addr of uncachedSet) {
      const info: AgentInfo = { name: null, btcAddress: null };
      infoMap.set(addr, info);
      kvWrites.push(
        kv.put(`${CACHE_KEY_PREFIX}${addr}`, JSON.stringify(info), {
          expirationTtl: CACHE_TTL_SECONDS,
        }),
      );
    }
  }

  // Fire KV writes in parallel and wait for all of them to settle
  await Promise.allSettled(kvWrites);

  return infoMap;
}
