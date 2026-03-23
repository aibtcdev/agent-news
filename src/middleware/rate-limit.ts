import type { Context, Next } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { resolveAgentName } from "../services/agent-resolver";

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  key: string;
  maxRequests: number;
  windowSeconds: number;
  /**
   * Optional header name used to refine the rate-limit bucket for
   * authenticated callers. When set and the header carries a non-empty
   * value, the bucket is keyed by `{key}:{identity}` so that distinct
   * identities behind the same IP get independent quotas. An IP-based
   * bucket is **always** checked first to prevent unauthenticated callers
   * from spoofing the header to bypass per-IP limits.
   */
  identityHeader?: string;
}

/**
 * Factory that creates a Hono rate-limit middleware scoped to a given key.
 * Reads CF-Connecting-IP and checks a sliding window counter in NEWS_KV.
 * Returns 429 when the limit is exceeded.
 *
 * When `identityHeader` is provided, **two** buckets are checked:
 *   1. IP-based bucket (always enforced — prevents header-spoofing bypass)
 *   2. Identity-based bucket (only when header is present and non-empty)
 * The request must pass both buckets.
 *
 * On rate-limit violations, the BTC address from X-BTC-Address is included in
 * warning logs (along with agent_name from the registry) so operators can
 * identify and contact misbehaving agents. Agent name resolution is
 * fire-and-forget — it never delays the 429 response.
 *
 * All 429 responses include a `Retry-After` header and `retry_after` field in
 * the JSON body so clients can implement proper exponential backoff.
 *
 * KNOWN LIMITATION — Worker (KV) level only:
 * Rate limiting is enforced at the Cloudflare Worker layer using KV storage.
 * A caller with direct access to the Durable Object (e.g. via internal DO-to-DO
 * RPC or a misconfigured binding) can bypass this middleware entirely. This is an
 * accepted trade-off for the current architecture; the DO itself does not enforce
 * its own rate limits.
 */
export function createRateLimitMiddleware(opts: RateLimitOptions) {
  return async function rateLimitMiddleware(
    c: Context<{ Bindings: Env; Variables: AppVariables }>,
    next: Next
  ) {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const identity = opts.identityHeader
      ? (c.req.header(opts.identityHeader)?.trim() || null)
      : null;

    // Always check IP-based bucket first (prevents identity header spoofing)
    const ipKey = `ratelimit:${opts.key}:${ip}`;
    const blocked = await checkBucket(c, ipKey, opts, ip, identity);
    if (blocked) return blocked;

    // If an identity header is present, also check the identity bucket.
    // This gives each authenticated caller their own quota independent of IP.
    if (identity) {
      const idKey = `ratelimit:${opts.key}:id:${identity}`;
      const idBlocked = await checkBucket(c, idKey, opts, ip, identity);
      if (idBlocked) return idBlocked;
    }

    return next();
  };
}

async function checkBucket(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  rlKey: string,
  opts: RateLimitOptions,
  ip: string,
  identity: string | null
) {
  const record =
    (await c.env.NEWS_KV.get<RateLimitRecord>(rlKey, "json")) ?? {
      count: 0,
      resetAt: 0,
    };

  const now = Date.now();

  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + opts.windowSeconds * 1000;
  } else {
    record.count += 1;
  }

  if (record.count > opts.maxRequests) {
    const retryAfter = Math.ceil((record.resetAt - now) / 1000);
    const logger = c.get("logger");

    // Read BTC address for agent identification in logs.
    // Always check X-BTC-Address header first (present on all authenticated routes).
    // Fall back to the identity value when identityHeader is configured.
    // Fire-and-forget: agent name resolution must never delay the 429 response.
    const btcAddress = c.req.header("X-BTC-Address")?.trim() || identity || null;

    logger.warn("rate limit exceeded", {
      key: opts.key,
      ip,
      btc_address: btcAddress ?? undefined,
      auth: btcAddress ? undefined : "missing",
      bucket: rlKey,
      count: record.count,
      max: opts.maxRequests,
      retry_after: retryAfter,
    });

    // Enrich the log with agent name asynchronously — KV hit is fast (cached edge),
    // but an external fetch on cache miss could take seconds. Never block the 429.
    if (btcAddress) {
      c.executionCtx.waitUntil(
        resolveAgentName(c.env.NEWS_KV, btcAddress)
          .then((info) => {
            if (info.name) {
              logger.warn("rate limit — agent identified", {
                key: opts.key,
                ip,
                btc_address: btcAddress,
                agent_name: info.name,
              });
            }
          })
          .catch(() => {
            // Ignore resolution errors — name enrichment is best-effort
          }),
      );
    }
    c.header("Retry-After", String(retryAfter));
    return c.json(
      {
        error: `Rate limited. Try again in ${retryAfter}s`,
        retry_after: retryAfter,
        message: `Too many requests. Wait at least ${retryAfter} seconds before retrying. Implement exponential backoff to avoid repeated rate limiting.`,
      },
      429
    );
  }

  await c.env.NEWS_KV.put(rlKey, JSON.stringify(record), {
    expirationTtl: opts.windowSeconds,
  });

  return null;
}
