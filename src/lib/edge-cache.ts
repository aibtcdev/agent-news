/**
 * Workers edge-cache helper.
 *
 * Workers responses don't automatically populate Cloudflare's edge cache —
 * the `Cache-Control` header alone is treated as "instructions for downstream
 * caches" but no downstream cache is ever asked unless the response is
 * explicitly stored via `caches.default.put()`. This helper wraps the
 * match → put pattern so route handlers can opt in with a single call.
 *
 * Pattern:
 *
 *   router.get("/api/foo", async (c) => {
 *     const cached = await edgeCacheMatch(c);
 *     if (cached) return cached;
 *
 *     // ... build response ...
 *     c.header("Cache-Control", "public, max-age=60, s-maxage=300");
 *     const response = c.json(payload);
 *     edgeCachePut(c, response);
 *     return response;
 *   });
 *
 * Cache key is the canonical request URL (so `?before=2026-04-22` and the
 * naked path get separate entries). TTL is taken from the response's
 * `Cache-Control` `s-maxage` directive at edge level. Browser revalidation
 * still honours `max-age` independently.
 */
import type { Context } from "hono";
import type { Env, AppVariables } from "./types";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

function buildCacheKey(c: Ctx): Request {
  return new Request(new URL(c.req.url).toString(), { method: "GET" });
}

/**
 * Look up the current request in the edge cache. Returns the cached Response
 * (with an `X-Edge-Cache: HIT` header attached for observability) or `null`
 * on miss. Safe to call from any GET handler.
 */
export async function edgeCacheMatch(c: Ctx): Promise<Response | null> {
  const cached = await caches.default.match(buildCacheKey(c));
  if (!cached) return null;
  // Clone-via-Response constructor so we can mutate the headers without
  // touching the body stream (which would break subsequent reads).
  const hit = new Response(cached.body, cached);
  hit.headers.set("X-Edge-Cache", "HIT");
  return hit;
}

/**
 * Store the response in the edge cache for the duration of its
 * `Cache-Control` `s-maxage`. Tags an `X-Edge-Cache: MISS` header on the
 * response we return to the client (so the caller can confirm the write
 * happened). The actual cache write runs via `executionCtx.waitUntil` so
 * the user doesn't pay any latency for it.
 */
export function edgeCachePut(c: Ctx, response: Response): void {
  response.headers.set("X-Edge-Cache", "MISS");
  c.executionCtx.waitUntil(
    caches.default.put(buildCacheKey(c), response.clone())
  );
}
