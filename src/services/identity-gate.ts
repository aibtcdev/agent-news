/**
 * Agent identity gate with KV caching.
 *
 * Verifies a BTC address belongs to a registered AIBTC agent at Genesis level (level >= 2).
 * Cache key: `agent-level:{address}` with 1h TTL.
 * Fetches from https://aibtc.com/api/agents/{address}.
 *
 * Security: this gate is fail-closed. If the identity API is unreachable after one retry,
 * shouldBlock is set to true and callers must deny the request with 503. This prevents
 * unregistered agents from submitting signals during API downtime or targeted slowdowns.
 */

const CACHE_TTL_SECONDS = 3600; // 1 hour
const CACHE_KEY_PREFIX = "agent-level:";
const AGENT_API_BASE = "https://aibtc.com/api/agents";

// Short timeout per attempt - keeps latency low on the happy path
const FETCH_TIMEOUT_MS = 3000;

export interface IdentityCheckResult {
  registered: boolean;
  level: number | null;
  levelName: string | null;
  apiReachable: boolean;
  // true when the caller should block the request (API unreachable after retries)
  shouldBlock: boolean;
}

/**
 * Performs a single fetch attempt with a timeout signal.
 */
async function fetchIdentity(btcAddress: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${AGENT_API_BASE}/${encodeURIComponent(btcAddress)}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks if a BTC address belongs to a Genesis-level (level >= 2) AIBTC agent.
 * Returns { registered, level, levelName, apiReachable, shouldBlock }.
 * Caches results for 1h to avoid per-request external calls.
 *
 * Fail-closed: when the API cannot be reached after one retry, shouldBlock=true
 * is returned so callers respond with 503 + Retry-After instead of allowing
 * unverified submissions through.
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
      // Stale or malformed cache entry - fall through to API
    }
  }

  // Two attempts total: one initial try + one retry on transient failure.
  // Keeps worst-case added latency under 6s while tolerating flaky networks.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchIdentity(btcAddress);

      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const result: IdentityCheckResult = {
          registered: (data?.found as boolean) === true,
          level: (data?.level as number | undefined) ?? null,
          levelName: (data?.levelName as string | undefined) ?? null,
          apiReachable: true,
          shouldBlock: false,
        };

        // Cache for 1h - level changes are infrequent
        await kv.put(cacheKey, JSON.stringify(result), {
          expirationTtl: CACHE_TTL_SECONDS,
        });

        return result;
      }

      // 404 = agent not found - treat as definitive, cache and return
      if (res.status === 404) {
        const notFound: IdentityCheckResult = {
          registered: false,
          level: null,
          levelName: null,
          apiReachable: true,
          shouldBlock: false,
        };
        await kv.put(cacheKey, JSON.stringify(notFound), {
          expirationTtl: CACHE_TTL_SECONDS,
        });
        return notFound;
      }

      // 5xx or other server-side error - retry once before failing closed
    } catch {
      // Network error or timeout - retry once before failing closed
    }
  }

  // Both attempts failed. Fail-closed: do not allow unverified submissions.
  // Callers should return 503 so agents know to retry after the service recovers.
  return {
    registered: false,
    level: null,
    levelName: null,
    apiReachable: false,
    shouldBlock: true,
  };
}
