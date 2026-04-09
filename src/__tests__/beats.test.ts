import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { BeatSchema, BeatWithLifecycleSchema } from "@aibtc/tx-schemas/news";

/**
 * Integration tests for /api/beats endpoints.
 * Tests validation layer and error responses (happy-path CRUD requires BIP-322 auth).
 */
describe("GET /api/beats", () => {
  it("returns 200 with an array", async () => {
    const res = await SELF.fetch("http://example.com/api/beats");
    expect(res.status).toBe(200);
    const body = await res.json<unknown[]>();
    expect(Array.isArray(body)).toBe(true);
  });

  it("lists only the 3 active beats by default", async () => {
    const res = await SELF.fetch("http://example.com/api/beats");
    expect(res.status).toBe(200);
    const body = await res.json<Array<{ slug: string; lifecycle: string; is_fileable: boolean }>>();
    expect(body).toHaveLength(3);
    expect(body.map((beat) => beat.slug).sort()).toEqual([
      "aibtc-network",
      "bitcoin-macro",
      "quantum",
    ]);
    expect(body.every((beat) => BeatWithLifecycleSchema.safeParse(beat).success)).toBe(true);
    body.forEach((beat) => {
      expect(beat.lifecycle).toBe("active");
      expect(beat.is_fileable).toBe(true);
    });
  });

  it("exposes retired beats through the archive view", async () => {
    const res = await SELF.fetch("http://example.com/api/beats/archive");
    expect(res.status).toBe(200);
    const body = await res.json<Array<{ slug: string; lifecycle: string; archive_only: boolean }>>();
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((beat) => BeatWithLifecycleSchema.safeParse(beat).success)).toBe(true);
    expect(body.some((beat) => beat.slug === "onboarding")).toBe(true);
    expect(body.every((beat) => beat.lifecycle === "grace" || beat.lifecycle === "retired")).toBe(true);
  });

  it("returns beat fields using the shared tx-schemas snake_case contract", async () => {
    const res = await SELF.fetch("http://example.com/api/beats");
    expect(res.status).toBe(200);
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(BeatSchema.safeParse(body[0]).success).toBe(true);
    expect(body[0]).toHaveProperty("created_by");
    expect(body[0]).toHaveProperty("created_at");
    expect(body[0]).toHaveProperty("updated_at");
    expect(body[0]).not.toHaveProperty("claimedBy");
    expect(body[0]).not.toHaveProperty("claimedAt");
  });
});

describe("GET /api/beats/:slug — not found", () => {
  it("returns 404 for a nonexistent beat slug", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/beats/this-beat-does-not-exist"
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("not found");
  });
});

describe("GET /api/beats/:slug", () => {
  it("keeps retired beat detail readable for historical hydration", async () => {
    const res = await SELF.fetch("http://example.com/api/beats/onboarding");
    expect(res.status).toBe(200);
    const body = await res.json<{ slug: string; lifecycle: string; archive_only: boolean }>();
    expect(BeatWithLifecycleSchema.safeParse(body).success).toBe(true);
    expect(body.slug).toBe("onboarding");
    expect(body.lifecycle).toBe("retired");
    expect(body.archive_only).toBe(true);
  });
});

describe("POST /api/beats — validation errors", () => {
  // NOTE: The rate limiter (5 req/hour) runs before all validation checks,
  // using CF-Connecting-IP (defaults to "unknown" in tests) + a fresh KV per test file.
  // Tests are ordered: auth check first (reaches rate limit last), then validation tests.

  it("returns 401 when auth headers are missing (valid data, no auth)", async () => {
    // This test must run before the rate limit is exhausted (5 req max)
    const res = await SELF.fetch("http://example.com/api/beats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "my-beat",
        name: "My Beat",
        created_by: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBeTruthy();
  });

  it("returns 400 when body is not valid JSON", async () => {
    const res = await SELF.fetch("http://example.com/api/beats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBeTruthy();
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await SELF.fetch("http://example.com/api/beats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Beat" }), // missing slug and created_by
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("Missing required fields");
  });

  it("returns 400 for an invalid slug", async () => {
    const res = await SELF.fetch("http://example.com/api/beats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "INVALID SLUG!",
        name: "My Beat",
        created_by: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("slug");
  });

  it("returns 400 for an invalid BTC address", async () => {
    const res = await SELF.fetch("http://example.com/api/beats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "my-beat",
        name: "My Beat",
        created_by: "not-a-btc-address",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("BTC address");
  });

  // NOTE: Only 5 POST tests total to stay within the rate limit (5 req/hour per IP).
  // Color validation is covered by the validators unit tests in validators.test.ts.
});

describe("DELETE /api/beats/:slug — validation errors", () => {
  it("returns 400 when body is not valid JSON", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/beats/some-beat",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBeTruthy();
  });

  it("returns 400 when btc_address is missing", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/beats/some-beat",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("btc_address");
  });

  it("returns 400 for an invalid BTC address", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/beats/some-beat",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ btc_address: "not-valid" }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("BTC address");
  });

  it("returns 401 when auth headers are missing (valid data, no auth)", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/beats/some-beat",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        }),
      }
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBeTruthy();
  });
});
