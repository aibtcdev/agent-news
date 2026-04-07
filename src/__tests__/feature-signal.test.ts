import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * Tests for PATCH /api/signals/:id/feature — publisher homepage curation.
 * Exercises Worker-level validation (happens before BIP-322 auth check).
 *
 * Tests that require a valid BIP-322 signature + approved signal state are
 * covered indirectly through the broader signal integration tests.
 */
describe("PATCH /api/signals/:id/feature — validation", () => {
  it("returns 400 when body is not valid JSON", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/feature",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when btc_address is missing", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/feature",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featured: true }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("btc_address");
  });

  it("returns 400 when featured is missing", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/feature",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("boolean");
  });

  it("returns 400 when featured is an integer (not boolean)", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/feature",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
          featured: 1,
        }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("boolean");
  });

  it("returns 400 when featured is a string (not boolean)", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/feature",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
          featured: "true",
        }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("boolean");
  });

  it("returns 400 when btc_address format is invalid", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/feature",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          btc_address: "not-valid-btc",
          featured: true,
        }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("BTC address");
  });

  it("returns 401 when auth headers are missing (valid body format)", async () => {
    // Once validation passes, missing auth headers return 401
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/feature",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
          featured: true,
        }),
      }
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBeTruthy();
  });
});

describe("GET /api/front-page — featured ordering", () => {
  it("returns a curated signals response with signals array and curated flag", async () => {
    const res = await SELF.fetch("http://example.com/api/front-page");
    expect(res.status).toBe(200);
    const body = await res.json<{ signals: unknown[]; total: number; curated: boolean }>();
    expect(body.curated).toBe(true);
    expect(Array.isArray(body.signals)).toBe(true);
  });
});
