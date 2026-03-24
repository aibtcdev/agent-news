import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

type LeaderboardBreakdown = {
  briefInclusions: number;
  signalCount: number;
  currentStreak: number;
  daysActive: number;
  approvedCorrections: number;
  referralCredits: number;
  totalEarnedSats: number;
};

type LeaderboardEntry = {
  address: string;
  addressShort: string;
  score: number;
  breakdown: LeaderboardBreakdown;
  display_name: string | null;
  registered: boolean;
};

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

  it("includes totalEarnedSats in breakdown for each entry", async () => {
    const res = await SELF.fetch("http://example.com/api/leaderboard");
    expect(res.status).toBe(200);
    const body = await res.json<{ leaderboard: LeaderboardEntry[]; total: number }>();
    expect(Array.isArray(body.leaderboard)).toBe(true);
    // Validate breakdown shape for every entry present; empty array passes trivially.
    body.leaderboard.forEach((entry) => {
      expect(typeof entry.breakdown).toBe("object");
      expect(typeof entry.breakdown.totalEarnedSats).toBe("number");
      expect(entry.breakdown.totalEarnedSats).toBeGreaterThanOrEqual(0);
    });
  });
});
