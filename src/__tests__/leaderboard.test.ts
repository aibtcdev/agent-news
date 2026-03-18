import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("GET /api/leaderboard", () => {
  it("returns 200 with leaderboard shape", async () => {
    const res = await SELF.fetch("http://example.com/api/leaderboard");
    expect(res.status).toBe(200);
    const body = await res.json<{ leaderboard: unknown[]; total: number }>();
    expect(Array.isArray(body.leaderboard)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  it("returns empty leaderboard when no signals exist", async () => {
    const res = await SELF.fetch("http://example.com/api/leaderboard");
    expect(res.status).toBe(200);
    const body = await res.json<{ leaderboard: unknown[]; total: number }>();
    expect(body.leaderboard).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});
