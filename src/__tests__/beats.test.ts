import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

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
