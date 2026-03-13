import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * Integration tests for /api/signals endpoints.
 * Tests validation layer and error responses (happy-path CRUD requires BIP-322 auth).
 */
describe("GET /api/signals", () => {
  it("returns 200 with signal list shape", async () => {
    const res = await SELF.fetch("http://example.com/api/signals");
    expect(res.status).toBe(200);
    const body = await res.json<{
      signals: unknown[];
      total: number;
      filtered: number;
    }>();
    expect(Array.isArray(body.signals)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.filtered).toBe("number");
  });

  it("accepts query parameters without error", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals?limit=10&beat=tech"
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /api/signals/:id — not found", () => {
  it("returns 404 for a nonexistent signal ID", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("not found");
  });
});

describe("POST /api/signals — validation errors", () => {
  it("returns 400 when body is not valid JSON", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headline: "Something happened" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("Missing required fields");
  });

  it("returns 400 for an invalid beat_slug", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beat_slug: "INVALID SLUG!",
        btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        headline: "Something happened",
        sources: [{ url: "https://example.com", title: "Example" }],
        tags: ["bitcoin"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("beat_slug");
  });

  it("returns 400 for an invalid BTC address", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beat_slug: "my-beat",
        btc_address: "not-a-btc-address",
        headline: "Something happened",
        sources: [{ url: "https://example.com", title: "Example" }],
        tags: ["bitcoin"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("BTC address");
  });

  it("returns 400 for an invalid headline (too long)", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beat_slug: "my-beat",
        btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        headline: "a".repeat(121),
        sources: [{ url: "https://example.com", title: "Example" }],
        tags: ["bitcoin"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("headline");
  });

  it("returns 400 for invalid sources (empty array)", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beat_slug: "my-beat",
        btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        headline: "Something happened",
        sources: [],
        tags: ["bitcoin"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("sources");
  });

  it("returns 400 for invalid tags (uppercase)", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beat_slug: "my-beat",
        btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        headline: "Something happened",
        sources: [{ url: "https://example.com", title: "Example" }],
        tags: ["BITCOIN"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("tags");
  });

  it("returns 401 when auth headers are missing (all fields valid)", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beat_slug: "my-beat",
        btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        headline: "Something happened",
        sources: [{ url: "https://example.com", title: "Example" }],
        tags: ["bitcoin"],
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBeTruthy();
  });
});
