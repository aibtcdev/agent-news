import type { Context, Next } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { resolveAgentName } from "../services/agent-resolver";

const RATE_LIMIT_BINDING_CONFIG = {
  read: { maxRequests: 300, periodSeconds: 60 },
  mutating: { maxRequests: 20, periodSeconds: 60 },
  authenticated: { maxRequests: 200, periodSeconds: 60 },
} as const;

interface RateLimitOptions {
  key: string;
  binding?: "read" | "mutating" | "authenticated";
  /**
   * Optional header name used to refine the rate-limit bucket for
   * authenticated callers. When set and the header carries a non-empty
   * value, the bucket is keyed by `{key}:id:{identity}` so that distinct
   * identities behind the same IP get independent quotas.
   */
  identityHeader?: string;
  /**
   * One or more header names. When set, the middleware skips rate limiting
   * entirely if **none** of the listed headers are present or non-empty.
   * Use this on x402-gated routes so unauthenticated probes (which receive
   * a 402 back) do not burn a rate-limit slot. Only requests that carry at
   * least one of the headers — i.e. real payment attempts — are counted
   * against the quota.
   *
   * Accepts a single string or an array for routes that support multiple
   * header names (e.g. both `X-PAYMENT` and `payment-signature`).
   */
  skipIfMissingHeaders?: string | string[];
  /**
   * HTTP methods to exempt from rate limiting entirely.
   * Use this to exclude read-only methods (e.g. "GET", "HEAD") from a
   * limiter that is shared with mutating methods on the same route prefix.
   * Requests whose method matches any entry in this list pass through
   * without consuming a rate-limit slot.
   *
   * Example: `skipMethods: ["GET", "HEAD"]`
   */
  skipMethods?: string | string[];
}

/**
 * Factory that creates a Hono rate-limit middleware scoped to a given key.
 * Reads CF-Connecting-IP or an authenticated identity header and checks a
 * first-party Cloudflare Rate Limiting binding. Returns 429 when limited.
 *
 * Every counted request checks an IP bucket first. Routes that explicitly set
 * `identityHeader` also check a second identity bucket, which gives signed
 * callers independent quotas without letting spoofable headers bypass the IP
 * bucket. The old KV implementation used long-window counters; the Cloudflare
 * binding intentionally enforces short-window burst limits, which removes
 * per-request NEWS_KV writes from the request path.
 *
 * On rate-limit violations, the BTC address from X-BTC-Address is included in
 * warning logs (along with agent_name from the registry) so operators can
 * identify and contact misbehaving agents. Agent name resolution is
 * fire-and-forget — it never delays the 429 response.
 *
 * All 429 responses include a `Retry-After` header and `retry_after` field in
 * the JSON body so clients can implement proper exponential backoff.
 *
 * KNOWN LIMITATION — Worker level only:
 * Rate limiting is enforced at the Cloudflare Worker layer using the
 * account-level Rate Limiting API. A caller with direct access to the Durable
 * Object can bypass this middleware entirely; the DO itself does not enforce
 * its own rate limits.
 */
export function createRateLimitMiddleware(opts: RateLimitOptions) {
  return async function rateLimitMiddleware(
    c: Context<{ Bindings: Env; Variables: AppVariables }>,
    next: Next
  ) {
    // Skip rate limiting for exempted HTTP methods (e.g. read-only GET/HEAD).
    // This lets a single middleware instance cover a route family while giving
    // read operations their own, more generous limiter (or no limiter at all).
    if (opts.skipMethods) {
      const methods = Array.isArray(opts.skipMethods)
        ? opts.skipMethods
        : [opts.skipMethods];
      if (methods.some((m) => m.toUpperCase() === c.req.method.toUpperCase())) {
        return next();
      }
    }

    // If none of the required headers are present (e.g. X-PAYMENT on x402
    // routes), skip rate limiting entirely. The handler will return the
    // appropriate 402/401 response for free — probes should never burn a
    // rate-limit slot.
    if (opts.skipIfMissingHeaders) {
      const headers = Array.isArray(opts.skipIfMissingHeaders)
        ? opts.skipIfMissingHeaders
        : [opts.skipIfMissingHeaders];
      const hasAny = headers.some((h) => c.req.header(h)?.trim());
      if (!hasAny) return next();
    }

    const blocked = await checkRateLimit(c, opts);
    if (blocked) return blocked;

    return next();
  };
}

export async function checkRateLimit(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  opts: RateLimitOptions
) {
  const binding = opts.binding ?? "mutating";
  const limiter = selectLimiter(c.env, binding);
  const config = RATE_LIMIT_BINDING_CONFIG[binding];
  if (!limiter) {
    const logger = c.get("logger");
    logger.error("rate limit binding missing", {
      key: opts.key,
      binding,
    });
    if (c.env.ENVIRONMENT === "production" || c.env.ENVIRONMENT === "staging") {
      return c.json(
        { error: "Rate limit service unavailable", retry_after: config.periodSeconds },
        503
      );
    }
    return null;
  }

  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const btcAddress = c.req.header("X-BTC-Address")?.trim() || null;
  const ipBucket = `${opts.key}:ip:${ip}`;
  const ipBlocked = await checkBindingBucket(c, limiter, config, opts.key, ipBucket, ip, btcAddress);
  if (ipBlocked) return ipBlocked;

  const identity = opts.identityHeader
    ? (c.req.header(opts.identityHeader)?.trim() || null)
    : null;
  if (identity) {
    const identityBucket = `${opts.key}:id:${identity}`;
    const identityBlocked = await checkBindingBucket(
      c,
      limiter,
      config,
      opts.key,
      identityBucket,
      ip,
      btcAddress ?? identity
    );
    if (identityBlocked) return identityBlocked;
  }

  return null;
}

async function checkBindingBucket(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  limiter: RateLimit,
  config: (typeof RATE_LIMIT_BINDING_CONFIG)[keyof typeof RATE_LIMIT_BINDING_CONFIG],
  key: string,
  bucket: string,
  ip: string,
  btcAddress: string | null
) {
  const { success } = await limiter.limit({ key: bucket });
  if (success) return null;

  const retryAfter = config.periodSeconds;
  const logger = c.get("logger");

  logger.warn("rate limit exceeded", {
    key,
    ip,
    btc_address: btcAddress ?? undefined,
    auth: btcAddress ? undefined : "missing",
    bucket,
    max: config.maxRequests,
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
              key,
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

function selectLimiter(
  env: Env,
  binding: NonNullable<RateLimitOptions["binding"]>
): RateLimit | undefined {
  switch (binding) {
    case "read":
      return env.RATE_LIMIT_READ;
    case "authenticated":
      return env.RATE_LIMIT_AUTHENTICATED;
    case "mutating":
      return env.RATE_LIMIT_MUTATING;
  }
}
