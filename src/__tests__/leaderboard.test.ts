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

async function seed(body: Record<string, unknown>): Promise<void> {
  const res = await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Seed failed (${res.status}): ${await res.text()}`);
  }
}

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

  it("excludes editor-covered brief inclusion earnings from unpaidSats without removing score credit", async () => {
    const address = "bc1qeditorcovered000000000000000000000000000";
    const signalId = "editor-covered-signal-1";
    const briefDate = "2026-04-09";
    const createdAt = "2026-04-09T12:00:00.000Z";

    await seed({
      signals: [
        {
          id: signalId,
          beat_slug: "quantum",
          btc_address: address,
          headline: "Editor-covered earning keeps score credit",
          created_at: createdAt,
          status: "brief_included",
        },
      ],
      briefs: [
        {
          date: briefDate,
          text: "Quantum brief",
          compiled_at: "2026-04-10T00:00:00.000Z",
          inscription_id: "editorcoveredi0",
        },
      ],
      brief_signals: [
        {
          brief_date: briefDate,
          signal_id: signalId,
          btc_address: address,
          created_at: createdAt,
        },
      ],
      earnings: [
        {
          id: "editor-covered-earning-1",
          btc_address: address,
          amount_sats: 30_000,
          reason: "brief_inclusion",
          reference_id: signalId,
          created_at: createdAt,
          payout_txid: null,
          editor_covered_at: "2026-04-09T23:59:59.000Z",
          editor_payout_txid: "editor-flat-fee-txid",
        },
      ],
    });

    const res = await SELF.fetch("http://example.com/api/leaderboard");
    expect(res.status).toBe(200);
    const body = await res.json<{ leaderboard: LeaderboardEntry[]; total: number }>();
    const entry = body.leaderboard.find((row) => row.address === address);

    expect(entry).toBeDefined();
    expect(entry?.breakdown.briefInclusions).toBe(1);
    expect(entry?.breakdown.unpaidSats).toBe(0);
    expect(entry?.breakdown.totalEarnedSats).toBe(0);
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
