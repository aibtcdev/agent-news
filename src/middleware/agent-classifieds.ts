/**
 * Agent classifieds injection — turns every agent-bound news fetch into a
 * paid-ad surface without slowing the UI.
 *
 * Detection: browsers always send `Sec-Fetch-Site` (and the related
 * `Sec-Fetch-Mode` / `Sec-Fetch-Dest`). curl, the AIBTC MCP server, Node's
 * built-in fetch, Python's requests, etc. don't. Absence of `Sec-Fetch-Site`
 * is a reliable "not a browser" signal in practice; the only false-positive
 * is an agent driving Playwright, in which case the agent simply gets the UI
 * response — harmless.
 *
 * Behavior: after the route handler runs, for agent requests on a 200 JSON
 * object response, we attach 3 random active+approved classifieds under the
 * `classifieds` key. We skip when:
 *   - the response is non-200 or non-JSON,
 *   - the body is a JSON array (would require a breaking shape change), or
 *   - the body already has a `classifieds` key (e.g. /api/init,
 *     /api/classifieds*) — the route already handles its own ad surface.
 *
 * Cache: agent responses are returned with `Cache-Control: private, no-store`
 * so downstream caches don't lock in a single rotation pick. The route's own
 * edge cache is unaffected because `edgeCachePut` clones the response BEFORE
 * this middleware mutates it — browsers continue to hit the cached payload at
 * full speed.
 */

import type { MiddlewareHandler } from "hono";
import type { Env, AppVariables, AppContext } from "../lib/types";
import { getClassifiedsRotation } from "../lib/do-client";
import { transformClassified } from "../routes/classifieds";

/**
 * True when the request looks like it came from a non-browser caller (curl,
 * MCP, SDK, etc.). Browsers always send `Sec-Fetch-Site`; tools generally
 * do not.
 */
export function isAgentRequest(c: AppContext): boolean {
  return !c.req.header("sec-fetch-site");
}

/**
 * Per-Worker-instance cache for the rotation result. The middleware fires on
 * every agent request to a listed news endpoint, and naive implementation
 * does a DO round-trip per fetch — at scale (multiple agents on minute-level
 * loops) that's a meaningful amount of avoidable load.
 *
 * 30s is short enough that ads still rotate in near-real-time across the
 * fleet, and long enough to absorb most bursty loops. Each Worker instance
 * has its own cache, so different PoPs naturally see different rotations.
 */
const ROTATION_CACHE_TTL_MS = 30_000;
let rotationCache:
  | {
      value: Awaited<ReturnType<typeof getClassifiedsRotation>>;
      expiresAt: number;
    }
  | null = null;

async function getCachedRotation(
  env: Env
): Promise<Awaited<ReturnType<typeof getClassifiedsRotation>>> {
  const now = Date.now();
  if (rotationCache && rotationCache.expiresAt > now) {
    return rotationCache.value;
  }
  const fresh = await getClassifiedsRotation(env);
  // Only memoize useful results — caching an empty/error result for 30s would
  // suppress legitimate ads as soon as one is approved.
  if (fresh.ok && fresh.data && fresh.data.length > 0) {
    rotationCache = { value: fresh, expiresAt: now + ROTATION_CACHE_TTL_MS };
  }
  return fresh;
}

export const agentClassifiedsMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> = async (c, next) => {
  await next();

  if (!isAgentRequest(c)) return;
  if (c.res.status !== 200) return;

  const contentType = c.res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return;

  let originalBody: unknown;
  try {
    originalBody = await c.res.clone().json();
  } catch {
    // Header lied about content-type, or body is malformed — bail out
    // rather than corrupt the response.
    return;
  }

  // Only inject onto plain object roots. Array-rooted endpoints (e.g.
  // /api/beats) would need a breaking shape change to carry an extra field.
  if (
    originalBody === null ||
    typeof originalBody !== "object" ||
    Array.isArray(originalBody)
  ) {
    return;
  }

  // Skip endpoints that already speak about classifieds. Avoids overwriting
  // /api/init's curated list or /api/classifieds*'s own response shape.
  if ("classifieds" in originalBody) return;

  let rotation: Awaited<ReturnType<typeof getClassifiedsRotation>>;
  try {
    rotation = await getCachedRotation(c.env);
  } catch {
    return;
  }
  if (!rotation.ok || !rotation.data || rotation.data.length === 0) return;

  const enriched = {
    ...(originalBody as Record<string, unknown>),
    classifieds: rotation.data.map(transformClassified),
  };

  const newRes = new Response(JSON.stringify(enriched), c.res);
  newRes.headers.set("content-type", "application/json");
  newRes.headers.set("cache-control", "private, no-store");
  newRes.headers.set("x-classifieds-injected", "1");

  // Hono's `c.res` setter merges the previous response's headers into the new
  // one, which would silently re-apply the route's `Cache-Control: public,
  // max-age=...` and clobber our `private, no-store`. Clearing first
  // (`c.res = undefined`) bypasses the merge so our headers stick.
  c.res = undefined;
  c.res = newRes;
};
