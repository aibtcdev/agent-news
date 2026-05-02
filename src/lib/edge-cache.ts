/**
 * Workers edge-cache helper with stale-while-revalidate (SWR).
 *
 * Workers responses don't automatically populate Cloudflare's edge cache —
 * the `Cache-Control` header alone is treated as "instructions for downstream
 * caches" but no downstream cache is ever asked unless the response is
 * explicitly stored via `caches.default.put()`. This helper wraps the
 * match → put pattern so route handlers can opt in with a single call.
 *
 * Two patterns:
 *
 * 1. Plain match/put (short-TTL, no SWR). Miss pays the full rebuild cost.
 *
 *   router.get("/api/foo", async (c) => {
 *     const cached = await edgeCacheMatch(c);
 *     if (cached) return cached;
 *     // ... build response ...
 *     c.header("Cache-Control", "public, max-age=60, s-maxage=300");
 *     const response = c.json(payload);
 *     edgeCachePut(c, response);
 *     return response;
 *   });
 *
 * 2. Stale-while-revalidate. Cache hits inside `freshSeconds` serve HIT; hits
 *    past that but still within the edge TTL serve the stale copy immediately
 *    and fire a background rebuild (via executionCtx.waitUntil). A KV lock
 *    tames the stampede when many concurrent requests see the same stale
 *    entry. Use for expensive payloads that back a Durable Object call which
 *    may be cold-booted (10s–120s) after quiet periods.
 *
 *   router.get("/api/expensive", async (c) => {
 *     const matched = await edgeCacheMatchSWR(c, { freshSeconds: 300 });
 *     if (matched && !matched.stale) return matched.response;
 *     if (matched && matched.stale) {
 *       triggerSWRRefresh(c, "expensive", () => buildAndPut(c));
 *       return matched.response;
 *     }
 *     return buildAndPut(c);
 *   });
 *
 * Cache key is the canonical request URL (so `?before=2026-04-22` and the
 * naked path get separate entries). Edge TTL is taken from the response's
 * `Cache-Control` `s-maxage` directive. Browser revalidation still honours
 * `max-age` independently. The SWR freshness window is an *inner* bound
 * managed by this module via a timestamp header — Cloudflare only knows
 * about the outer s-maxage TTL.
 */
import type { AppContext } from "./types";

const CACHED_AT_HEADER = "X-Edge-Cached-At";
const CACHE_AGE_HEADER = "X-Edge-Cache-Age";

export interface EdgeCacheKeyOptions {
  /**
   * Optional canonical path for routes whose query string does not change the
   * response. Use sparingly; most cached routes intentionally key by full URL.
   */
  cacheKeyPath?: string;
}

function buildCacheKey(c: AppContext, options: EdgeCacheKeyOptions = {}): Request {
  const url = new URL(c.req.url);
  if (options.cacheKeyPath) {
    url.pathname = options.cacheKeyPath;
    url.search = "";
  }
  return new Request(url.toString(), { method: "GET" });
}

/**
 * Is the current request running inside the test runtime?
 * vitest-pool-workers shares `caches.default` across tests in the same file,
 * so multiple tests hitting the same URL with different DO state would get
 * the cached first-run response — silently masking handler regressions.
 * Skipping cache in test keeps filter / status tests deterministic.
 */
function isTestEnv(c: AppContext): boolean {
  return c.env.ENVIRONMENT === "test";
}

/**
 * Look up the current request in the edge cache. Returns the cached Response
 * (with an `X-Edge-Cache: HIT` header attached for observability) or `null`
 * on miss. Safe to call from any GET handler.
 */
export async function edgeCacheMatch(
  c: AppContext,
  options: EdgeCacheKeyOptions = {}
): Promise<Response | null> {
  if (isTestEnv(c)) return null;
  const cached = await caches.default.match(buildCacheKey(c, options));
  if (!cached) return null;
  // Clone-via-Response constructor so we can mutate the headers without
  // touching the body stream (which would break subsequent reads).
  const hit = new Response(cached.body, cached);
  hit.headers.set("X-Edge-Cache", "HIT");
  return hit;
}

export interface SWRHit {
  response: Response;
  stale: boolean;
  ageSeconds: number;
}

export interface SWRMatchOptions {
  /**
   * How long a cached entry counts as "fresh". Past this, the entry is still
   * served (stale-while-revalidate) but callers should fire a background
   * rebuild. Should be well below the outer s-maxage edge TTL.
   */
  freshSeconds: number;
  cacheKeyPath?: string;
}

/**
 * Match the request against the edge cache, classifying the result as fresh
 * or stale based on a timestamp header we wrote at put-time.
 *
 * Matched responses include `X-Edge-Cache-Age` in whole seconds so health
 * probes can distinguish bounded stale serving from a cache entry whose
 * background refreshes have been failing for too long.
 *
 * Returns:
 *   - null           → cache miss, caller must rebuild.
 *   - { stale=false }→ fresh hit, serve as-is.
 *   - { stale=true } → stale hit, serve immediately AND trigger a background
 *                      refresh via triggerSWRRefresh().
 *
 * When the cached entry lacks the timestamp header (e.g. left over from
 * pre-SWR deployments), we treat it as stale so the next request kicks off
 * a refresh — strictly better than treating it as fresh forever.
 */
export async function edgeCacheMatchSWR(
  c: AppContext,
  options: SWRMatchOptions
): Promise<SWRHit | null> {
  if (isTestEnv(c)) return null;
  const cached = await caches.default.match(buildCacheKey(c, options));
  if (!cached) return null;
  const cachedAt = Number(cached.headers.get(CACHED_AT_HEADER) ?? "0");
  const ageSeconds = cachedAt > 0 ? (Date.now() - cachedAt) / 1000 : Number.POSITIVE_INFINITY;
  const stale = ageSeconds >= options.freshSeconds;
  const response = new Response(cached.body, cached);
  response.headers.set("X-Edge-Cache", stale ? "STALE" : "HIT");
  response.headers.set(
    CACHE_AGE_HEADER,
    Number.isFinite(ageSeconds) ? String(Math.max(0, Math.floor(ageSeconds))) : "unknown"
  );
  return { response, stale, ageSeconds };
}

/**
 * Store the response in the edge cache for the duration of its
 * `Cache-Control` `s-maxage`. Tags an `X-Edge-Cache: MISS` header on the
 * response we return to the client (so the caller can confirm the write
 * happened). The actual cache write runs via `executionCtx.waitUntil` so
 * the user doesn't pay any latency for it.
 *
 * An `X-Edge-Cached-At` timestamp header is written to the stored copy so
 * edgeCacheMatchSWR() can classify hits as fresh or stale on subsequent
 * requests. The live response returned to the current caller also carries
 * the stamp (harmless; helps debugging).
 */
export function edgeCachePut(
  c: AppContext,
  response: Response,
  options: EdgeCacheKeyOptions = {}
): void {
  if (isTestEnv(c)) return;
  response.headers.set(CACHED_AT_HEADER, String(Date.now()));
  const cacheCopy = response.clone();
  response.headers.set("X-Edge-Cache", "MISS");
  c.executionCtx.waitUntil(caches.default.put(buildCacheKey(c, options), cacheCopy));
}

/**
 * Fire a background rebuild for a stale cache entry, guarded by a short KV
 * lock so concurrent stale hits don't hammer the upstream (e.g. a cold
 * Durable Object) with duplicate rebuilds.
 *
 * The lock key is scoped by the `bucket` argument plus the request URL, so
 * different query combinations get their own locks — one stale `/foo?a=1`
 * rebuild doesn't block a concurrent stale `/foo?a=2` rebuild. TTL matches
 * the expected rebuild cost ceiling (cold DO ~120s in the worst case).
 *
 * KV is eventually consistent, so under a brief flurry of concurrent stale
 * hits 2–3 rebuilds may still fire in parallel. That is acceptable —
 * strict single-flight isn't worth a Durable Object's coordination cost
 * for a best-effort refresh.
 */
export function triggerSWRRefresh(
  c: AppContext,
  bucket: string,
  rebuild: () => Promise<unknown>,
  options: EdgeCacheKeyOptions = {}
): void {
  if (isTestEnv(c)) return;
  const requestUrl = new URL(c.req.url);
  const lockPath = options.cacheKeyPath ?? requestUrl.pathname;
  const lockSearch = options.cacheKeyPath ? "" : requestUrl.search;
  const lockKey = `swr-lock:${bucket}:${lockPath}${lockSearch}`;
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const existing = await c.env.NEWS_KV.get(lockKey);
        if (existing) return; // Another rebuild is already in-flight.
        await c.env.NEWS_KV.put(lockKey, "1", { expirationTtl: 120 });
        await rebuild();
      } catch (err) {
        const logger = c.get("logger");
        logger.warn("SWR rebuild failed", {
          bucket,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Release the lock eagerly on success so the next refresh window
        // doesn't wait for the 120s TTL to expire. Swallow delete errors —
        // the TTL is the backstop.
        try {
          await c.env.NEWS_KV.delete(lockKey);
        } catch {
          /* noop */
        }
      }
    })()
  );
}
