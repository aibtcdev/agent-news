import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";

/**
 * Tests for the `skipIfMissingHeaders` rate-limit middleware option.
 *
 * The classifieds POST route uses `skipIfMissingHeaders: ["X-PAYMENT", "payment-signature"]`
 * so that x402 probes (requests without a payment header) bypass rate limiting,
 * while real payment attempts are counted against the quota.
 *
 * These tests verify:
 *   1. Requests WITHOUT payment headers bypass rate limiting (return 402, not 429)
 *   2. Requests WITH X-PAYMENT header ARE rate limited (eventually return 429)
 *   3. Requests WITH payment-signature header ARE rate limited (eventually return 429)
 */

const CLASSIFIEDS_URL = "http://example.com/api/classifieds";
const VALID_BODY = JSON.stringify({ category: "services", headline: "Test Ad" });

/** Flush all rate-limit keys from KV so each test starts clean. */
async function clearRateLimitKeys() {
  const list = await env.NEWS_KV.list({ prefix: "ratelimit:classifieds:" });
  await Promise.all(list.keys.map((k) => env.NEWS_KV.delete(k.name)));
}

describe("skipIfMissingHeaders — classifieds rate limiting", () => {
  beforeEach(async () => {
    await clearRateLimitKeys();
  });

  it("requests WITHOUT payment headers bypass rate limiting (always get 402)", async () => {
    // Send more requests than the rate limit (20 req / 10 min) — all should
    // return 402 because missing-header requests are never counted.
    const results: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await SELF.fetch(CLASSIFIEDS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: VALID_BODY,
      });
      results.push(res.status);
    }

    // Every response should be 402 (payment required) — never 429
    expect(results.every((s) => s === 402)).toBe(true);
    expect(results).not.toContain(429);
  });

  it("requests WITH X-PAYMENT header ARE rate limited (eventually 429)", async () => {
    // The classified rate limit is 20 req / 10 min. Exhaust the quota.
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const res = await SELF.fetch(CLASSIFIEDS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PAYMENT": "dummy-payment-token",
        },
        body: VALID_BODY,
      });
      statuses.push(res.status);
    }

    // The first 20 requests should NOT be 429 (they pass rate limiting and
    // reach the handler — returning 402/400/503 depending on payment verification).
    const first20 = statuses.slice(0, 20);
    expect(first20).not.toContain(429);

    // At least one of the requests beyond the limit should be 429.
    const overflow = statuses.slice(20);
    expect(overflow).toContain(429);
  });

  it("requests WITH payment-signature header ARE rate limited (eventually 429)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const res = await SELF.fetch(CLASSIFIEDS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "payment-signature": "dummy-sig-token",
        },
        body: VALID_BODY,
      });
      statuses.push(res.status);
    }

    const first20 = statuses.slice(0, 20);
    expect(first20).not.toContain(429);

    const overflow = statuses.slice(20);
    expect(overflow).toContain(429);
  });

  it("429 response includes Retry-After header and retry_after field", async () => {
    // Exhaust the quota with X-PAYMENT header
    for (let i = 0; i < 21; i++) {
      await SELF.fetch(CLASSIFIEDS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PAYMENT": "dummy-payment-token",
        },
        body: VALID_BODY,
      });
    }

    // Next request should be rate limited
    const res = await SELF.fetch(CLASSIFIEDS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": "dummy-payment-token",
      },
      body: VALID_BODY,
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();

    const body = await res.json<{ retry_after: number; error: string }>();
    expect(body.retry_after).toBeGreaterThan(0);
    expect(body.error).toContain("Rate limited");
  });
});
