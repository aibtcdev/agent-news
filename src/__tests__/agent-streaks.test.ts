import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * Integration tests for GET /api/agent/:address/streaks endpoint.
 * Tests validation and response shape.
 */
describe("GET /api/agent/:address/streaks", () => {
  it("returns 400 for invalid address", async () => {
    const res = await SELF.fetch("http://example.com/api/agent/not-a-btc-address/streaks");
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("Invalid BTC address");
  });

  it("returns streak data shape for valid address", async () => {
    // Use a valid-looking bech32 address (may not have data, but should not 400)
    const address = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    const res = await SELF.fetch(`http://example.com/api/agent/${address}/streaks`);
    // Either 200 with data or 404 if no data exists
    expect([200, 404]).toContain(res.status);

    if (res.status === 200) {
      const body = await res.json<{
        streaks: Record<string, { current: number; longest: number; last_signal: string | null }>;
        global: { current: number; longest: number };
      }>();
      expect(body).toHaveProperty("streaks");
      expect(body).toHaveProperty("global");
      expect(typeof body.global.current).toBe("number");
      expect(typeof body.global.longest).toBe("number");
    }
  });

  it("returns seeded per-beat streak data", async () => {
    const address = "bc1qstreaktestaddr000000000000000000000dead";

    // Seed test data via test-seed endpoint
    const seedRes = await SELF.fetch("http://example.com/api/test-seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beat_streaks: [
          {
            btc_address: address,
            beat_slug: "ordinals",
            current_streak: 5,
            longest_streak: 12,
            last_signal_date: "2026-03-25",
            total_signals: 30,
          },
          {
            btc_address: address,
            beat_slug: "dev-tools",
            current_streak: 2,
            longest_streak: 2,
            last_signal_date: "2026-03-25",
            total_signals: 5,
          },
        ],
      }),
    });
    expect(seedRes.status).toBe(200);

    // Fetch streaks
    const res = await SELF.fetch(`http://example.com/api/agent/${address}/streaks`);
    expect(res.status).toBe(200);

    const body = await res.json<{
      streaks: Record<string, { current: number; longest: number; last_signal: string | null }>;
      global: { current: number; longest: number };
    }>();

    // Verify per-beat data
    expect(body.streaks).toHaveProperty("ordinals");
    expect(body.streaks.ordinals.current).toBe(5);
    expect(body.streaks.ordinals.longest).toBe(12);
    expect(body.streaks.ordinals.last_signal).toBe("2026-03-25");

    expect(body.streaks).toHaveProperty("dev-tools");
    expect(body.streaks["dev-tools"].current).toBe(2);
    expect(body.streaks["dev-tools"].longest).toBe(2);

    // Global should be max of per-beat
    expect(body.global.current).toBe(5);
    expect(body.global.longest).toBe(12);
  });
});
