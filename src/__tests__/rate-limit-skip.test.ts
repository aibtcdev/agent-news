import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * Tests for the `skipIfMissingHeaders` rate-limit middleware option.
 *
 * The classifieds POST route uses `skipIfMissingHeaders: ["X-PAYMENT", "payment-signature"]`
 * so that x402 probes (requests without a payment header) bypass rate limiting,
 * while real payment attempts are counted against the quota.
 *
 * NOTE: All tests share a single KV-backed rate-limit bucket keyed by IP
 * (CF-Connecting-IP is absent in tests, so the key is "unknown"). Tests are
 * ordered so that cumulative state is accounted for.
 */

const CLASSIFIEDS_URL = "http://example.com/api/classifieds";
const VALID_BODY = JSON.stringify({ category: "services", headline: "Test Ad" });

describe("skipIfMissingHeaders — classifieds rate limiting", () => {
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

  it("requests WITH payment headers ARE rate limited (eventually 429)", async () => {
    // The classified rate limit is 20 req / 10 min. Exhaust the quota with
    // X-PAYMENT, then confirm payment-signature also counts against the same bucket.
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

  it("payment-signature header also triggers rate limiting (not skipped)", async () => {
    // The IP bucket is already exhausted from the previous test.
    // A request with payment-signature should hit 429 — proving that
    // payment-signature is NOT treated as a missing header (i.e. not skipped).
    const res = await SELF.fetch(CLASSIFIEDS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "payment-signature": "dummy-sig-token",
      },
      body: VALID_BODY,
    });

    expect(res.status).toBe(429);
  });

  it("429 response includes Retry-After header and retry_after field", async () => {
    // Bucket is already exhausted — next payment request should be 429
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
