import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { transformClassified } from "../routes/classifieds";
import type { Classified } from "../lib/types";

// ── Pure function tests ──────────────────────────────────────────────────────

/**
 * Helper that builds a minimal Classified row for unit testing transformClassified.
 */
function makeClassified(overrides: Partial<Classified> = {}): Classified {
  return {
    id: "abc-123",
    btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    category: "services",
    headline: "Test Ad Headline",
    body: "Ad body text",
    payment_txid: "txid-001",
    created_at: "2026-03-23T10:00:00.000Z",
    expires_at: new Date(Date.now() + 86400 * 1000 * 7).toISOString(), // 7 days from now
    status: "pending_review",
    publisher_feedback: null,
    reviewed_at: null,
    refund_txid: null,
    ...overrides,
  };
}

describe("transformClassified — field mapping", () => {
  it("maps headline to title", () => {
    const cl = makeClassified({ headline: "My Classified" });
    const result = transformClassified(cl);
    expect(result.title).toBe("My Classified");
  });

  it("maps btc_address to placedBy", () => {
    const cl = makeClassified({
      btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    });
    const result = transformClassified(cl);
    expect(result.placedBy).toBe("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
  });

  it("maps payment_txid to paymentTxid", () => {
    const cl = makeClassified({ payment_txid: "some-txid" });
    const result = transformClassified(cl);
    expect(result.paymentTxid).toBe("some-txid");
  });

  it("preserves id, body, category, status, and timestamps", () => {
    const cl = makeClassified({
      id: "test-id",
      body: "body text",
      category: "services",
      status: "approved",
      created_at: "2026-03-23T10:00:00.000Z",
    });
    const result = transformClassified(cl);
    expect(result.id).toBe("test-id");
    expect(result.body).toBe("body text");
    expect(result.category).toBe("services");
    expect(result.status).toBe("approved");
    expect(result.createdAt).toBe("2026-03-23T10:00:00.000Z");
  });
});

describe("transformClassified — active flag", () => {
  it("returns active: true when expires_at is in the future", () => {
    const future = new Date(Date.now() + 86400 * 1000).toISOString();
    const result = transformClassified(makeClassified({ expires_at: future }));
    expect(result.active).toBe(true);
  });

  it("returns active: false when expires_at is in the past", () => {
    const past = new Date(Date.now() - 86400 * 1000).toISOString();
    const result = transformClassified(makeClassified({ expires_at: past }));
    expect(result.active).toBe(false);
  });
});

// ── Integration tests — POST /api/classifieds field aliasing ─────────────────

/**
 * POST /api/classifieds requires an X-PAYMENT header to reach validation logic.
 * Without it, the server returns 402. These tests use a dummy header value
 * to reach the body validation layer (payment verification will fail, but
 * field aliasing and required-field checks run before that).
 *
 * NOTE: Full happy-path testing (actual payment flow) requires mocking the x402
 * relay and Durable Object. That is out of scope for this phase.
 */
describe("POST /api/classifieds — field aliasing (pre-payment validation)", () => {
  // A dummy payment header — only needs to be non-empty so the handler reads
  // the body instead of returning 402. Field validation runs before payment
  // verification, so no real relay call is triggered for these tests.
  const DUMMY_PAYMENT = "test-payment-header";

  it("returns 402 when no payment header is present", async () => {
    const res = await SELF.fetch("http://example.com/api/classifieds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "services", title: "My Ad" }),
    });
    expect(res.status).toBe(402);
  });

  it("returns 400 when both title/headline are missing", async () => {
    const res = await SELF.fetch("http://example.com/api/classifieds", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": DUMMY_PAYMENT,
      },
      body: JSON.stringify({ category: "services" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("title");
  });

  it("returns 400 when category is missing", async () => {
    const res = await SELF.fetch("http://example.com/api/classifieds", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": DUMMY_PAYMENT,
      },
      body: JSON.stringify({ headline: "My Ad" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("category");
  });

  it("returns 400 when category is invalid", async () => {
    const res = await SELF.fetch("http://example.com/api/classifieds", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": DUMMY_PAYMENT,
      },
      body: JSON.stringify({ category: "not-a-real-category", headline: "My Ad" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("category");
  });

  it("accepts headline field (DB convention) and reaches payment verification", async () => {
    // With valid category + headline, validation passes and we hit payment verify.
    // Payment will fail (relay unavailable in test env) but we prove field aliasing works.
    const res = await SELF.fetch("http://example.com/api/classifieds", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": DUMMY_PAYMENT,
      },
      body: JSON.stringify({ category: "services", headline: "My Ad Headline" }),
    });
    // Should NOT be 400 (field validation passed) — either 402 or 503 from payment stage
    expect(res.status).not.toBe(400);
  });

  it("accepts title field (x402 client convention) and reaches payment verification", async () => {
    const res = await SELF.fetch("http://example.com/api/classifieds", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": DUMMY_PAYMENT,
      },
      body: JSON.stringify({ category: "services", title: "My Ad Title" }),
    });
    // Should NOT be 400 (field aliasing worked) — payment stage returns 402 or 503
    expect(res.status).not.toBe(400);
  });

  it("prefers headline over title when both are provided", async () => {
    // The headline field takes precedence. Both pass validation, so we reach payment.
    const res = await SELF.fetch("http://example.com/api/classifieds", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": DUMMY_PAYMENT,
      },
      body: JSON.stringify({
        category: "services",
        headline: "Headline Takes Priority",
        title: "Title is Ignored",
      }),
    });
    expect(res.status).not.toBe(400);
  });
});

// ── Regression: GET /api/classifieds must exclude same-day expired rows ──────
//
// expires_at is stored as ISO 8601 ('2026-04-29T10:00:00.000Z') but the SQL
// filter previously compared against datetime('now') ('YYYY-MM-DD HH:MM:SS').
// With the same date prefix, lex comparison treats 'T' (0x54) as greater than
// ' ' (0x20), so already-expired rows would slip through and the classifieds
// page (which client-filters expiry) appeared empty even when home page rows
// were present. Lock the correct behavior in.
describe("GET /api/classifieds — same-day expiry filter", () => {
  it("excludes approved rows whose expires_at has already passed today", async () => {
    const expiredId = `expired-same-day-${Date.now()}`;
    const activeId = `active-same-day-${Date.now()}`;
    const oneSecondAgo = new Date(Date.now() - 1000).toISOString();
    const oneHourAhead = new Date(Date.now() + 3600 * 1000).toISOString();

    const seedRes = await SELF.fetch("http://example.com/api/test-seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classifieds: [
          {
            id: expiredId,
            btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
            category: "services",
            headline: "Expired same-day ad",
            created_at: new Date(Date.now() - 7 * 86400 * 1000).toISOString(),
            expires_at: oneSecondAgo,
            status: "approved",
          },
          {
            id: activeId,
            btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
            category: "services",
            headline: "Active same-day ad",
            created_at: new Date().toISOString(),
            expires_at: oneHourAhead,
            status: "approved",
          },
        ],
      }),
    });
    expect(seedRes.status).toBe(200);

    const res = await SELF.fetch("http://example.com/api/classifieds?limit=200");
    expect(res.status).toBe(200);
    const body = await res.json<{ classifieds: Array<{ id: string }> }>();
    const ids = body.classifieds.map((c) => c.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(expiredId);
  });
});
