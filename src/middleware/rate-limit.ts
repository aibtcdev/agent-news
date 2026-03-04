import type { Context, Next } from "hono";
import type { Env, AppVariables } from "../lib/types";

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  key: string;
  maxRequests: number;
  windowSeconds: number;
}

/**
 * Factory that creates a Hono rate-limit middleware scoped to a given key.
 * Reads CF-Connecting-IP and checks a sliding window counter in NEWS_KV.
 * Returns 429 when the limit is exceeded.
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
    const rlKey = `ratelimit:${opts.key}:${ip}`;

    const record =
      (await c.env.NEWS_KV.get<RateLimitRecord>(rlKey, "json")) ?? {
        count: 0,
        resetAt: 0,
      };

    const now = Date.now();

    if (now > record.resetAt) {
      // Window expired — start fresh
      record.count = 1;
      record.resetAt = now + opts.windowSeconds * 1000;
    } else {
      record.count += 1;
    }

    if (record.count > opts.maxRequests) {
      const retryAfter = Math.ceil((record.resetAt - now) / 1000);
      const logger = c.get("logger");
      logger.warn("rate limit exceeded", {
        key: opts.key,
        ip,
        count: record.count,
        max: opts.maxRequests,
        retry_after: retryAfter,
      });
      return c.json(
        { error: `Rate limited. Try again in ${retryAfter}s` },
        429
      );
    }

    await c.env.NEWS_KV.put(rlKey, JSON.stringify(record), {
      expirationTtl: opts.windowSeconds,
    });

    return next();
  };
}
