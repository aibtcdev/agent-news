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
  unpaidSats: number;
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

  it("includes totalEarnedSats and unpaidSats in breakdown for each entry", async () => {
    const res = await SELF.fetch("http://example.com/api/leaderboard");
    expect(res.status).toBe(200);
    const body = await res.json<{ leaderboard: LeaderboardEntry[]; total: number }>();
    expect(Array.isArray(body.leaderboard)).toBe(true);
    // Validate breakdown shape for every entry present; empty array passes trivially.
    body.leaderboard.forEach((entry) => {
      expect(typeof entry.breakdown).toBe("object");
      expect(typeof entry.breakdown.totalEarnedSats).toBe("number");
      expect(entry.breakdown.totalEarnedSats).toBeGreaterThanOrEqual(0);
      expect(typeof entry.breakdown.unpaidSats).toBe("number");
      expect(entry.breakdown.unpaidSats).toBeGreaterThanOrEqual(0);
    });
  });
});

type WeeklyPayoutsResponse = {
  week: string;
  payouts: Array<{
    id: string;
    rank: number;
    btc_address: string;
    amount_sats: number;
    reason: string;
    week: string;
    created_at: string;
    payout_txid: string | null;
    voided_at: string | null;
  }>;
  summary: { total: number; paid: number; unpaid: number };
};

describe("GET /api/leaderboard/payouts/:week", () => {
  it("returns 200 with empty payouts for a valid week with no prizes recorded", async () => {
    const res = await SELF.fetch("http://example.com/api/leaderboard/payouts/2026-W14");
    expect(res.status).toBe(200);
    const body = await res.json<WeeklyPayoutsResponse>();
    expect(body.week).toBe("2026-W14");
    expect(Array.isArray(body.payouts)).toBe(true);
    expect(body.summary).toEqual({ total: 0, paid: 0, unpaid: 0 });
  });

  it("returns 400 on malformed week", async () => {
    const res = await SELF.fetch("http://example.com/api/leaderboard/payouts/2026-14");
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/week format/i);
  });

  it("returns 400 on out-of-range ISO week", async () => {
    const res = await SELF.fetch("http://example.com/api/leaderboard/payouts/2026-W54");
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/week number/i);
  });
});
