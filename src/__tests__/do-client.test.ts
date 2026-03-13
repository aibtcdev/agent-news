import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * Tests that exercise the do-client layer indirectly through HTTP routes.
 * These verify error propagation and not-found handling for DO-backed resources.
 */
describe("do-client error propagation via HTTP", () => {
  it("GET /api/beats returns empty array when DO has no beats", async () => {
    const res = await SELF.fetch("http://example.com/api/beats");
    expect(res.status).toBe(200);
    const body = await res.json<unknown[]>();
    // Fresh DO instance starts empty
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  it("GET /api/beats/:slug returns 404 for unknown beat", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/beats/unknown-beat-slug"
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBeTruthy();
    expect(body.error).toContain("not found");
  });

  it("GET /api/signals returns empty results for fresh DO", async () => {
    const res = await SELF.fetch("http://example.com/api/signals");
    expect(res.status).toBe(200);
    const body = await res.json<{
      signals: unknown[];
      total: number;
      filtered: number;
    }>();
    expect(body.signals.length).toBe(0);
    expect(body.total).toBe(0);
    expect(body.filtered).toBe(0);
  });

  it("GET /api/signals/:id returns 404 for unknown signal", async () => {
    const nonExistentId = "00000000-dead-beef-cafe-000000000000";
    const res = await SELF.fetch(
      `http://example.com/api/signals/${nonExistentId}`
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBeTruthy();
    expect(body.error).toContain("not found");
  });

  it("migration endpoint requires authentication (no key = 401 or 503)", async () => {
    const res = await SELF.fetch("http://example.com/api/internal/migrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "beats", records: [] }),
    });
    // Returns 503 if MIGRATION_KEY not configured, or 401 if key doesn't match
    expect([401, 503]).toContain(res.status);
  });

  it("migration status endpoint requires authentication (no key = 401 or 503)", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/internal/migrate/status"
    );
    // Returns 503 if MIGRATION_KEY not configured, or 401 if key doesn't match
    expect([401, 503]).toContain(res.status);
  });
});
