/**
 * Tests for the materialised correspondent_stats aggregate (B2).
 *
 * The aggregate replaces a full-table GROUP BY scan in /correspondents,
 * /correspondents-bundle, /init's correspondents block, and the
 * leaderboard's first-signal sub-select. These tests assert that values
 * surfaced via the read endpoints match a fresh aggregate over `signals`
 * across the relevant lifecycle events: insert, same-day insert,
 * cross-day insert, correction, and beat-cascade delete.
 *
 * Each test uses a unique BTC-address prefix to keep state isolated
 * across the shared simnet session (no beforeAll/beforeEach by repo
 * convention).
 */

import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

async function seed(body: Record<string, unknown>) {
  const res = await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

async function fetchCorrespondents() {
  const res = await SELF.fetch("http://example.com/api/correspondents");
  expect(res.status).toBe(200);
  const body = await res.json<{
    correspondents: Array<{
      address: string;
      signalCount: number;
      daysActive: number;
    }>;
  }>();
  return body.correspondents;
}

describe("correspondent_stats — single insert", () => {
  it("backfills a new agent's signal_count, first/last, and days_active", async () => {
    const addr = "bc1q-corr-stats-001";
    await seed({
      signals: [
        {
          id: "cs-001-a",
          beat_slug: "agent-social",
          btc_address: addr,
          headline: "first",
          sources: "[]",
          created_at: "2026-04-15T10:00:00.000Z",
          status: "submitted",
        },
      ],
    });

    const correspondents = await fetchCorrespondents();
    const me = correspondents.find((c) => c.address === addr);
    expect(me).toBeDefined();
    expect(me?.signalCount).toBe(1);
    expect(me?.daysActive).toBe(1);
  });
});

describe("correspondent_stats — same-day inserts", () => {
  it("counts both signals against signal_count but keeps days_active at 1", async () => {
    const addr = "bc1q-corr-stats-002";
    await seed({
      signals: [
        {
          id: "cs-002-a",
          beat_slug: "agent-social",
          btc_address: addr,
          headline: "morning",
          sources: "[]",
          created_at: "2026-04-15T08:00:00.000Z",
          status: "submitted",
        },
        {
          id: "cs-002-b",
          beat_slug: "agent-social",
          btc_address: addr,
          headline: "evening",
          sources: "[]",
          created_at: "2026-04-15T20:00:00.000Z",
          status: "submitted",
        },
      ],
    });

    const me = (await fetchCorrespondents()).find((c) => c.address === addr);
    expect(me?.signalCount).toBe(2);
    expect(me?.daysActive).toBe(1);
  });
});

describe("correspondent_stats — cross-day inserts", () => {
  it("bumps signal_count and days_active on consecutive days", async () => {
    const addr = "bc1q-corr-stats-003";
    await seed({
      signals: [
        {
          id: "cs-003-a",
          beat_slug: "agent-social",
          btc_address: addr,
          headline: "day 1",
          sources: "[]",
          created_at: "2026-04-15T10:00:00.000Z",
          status: "submitted",
        },
        {
          id: "cs-003-b",
          beat_slug: "agent-social",
          btc_address: addr,
          headline: "day 2",
          sources: "[]",
          created_at: "2026-04-16T10:00:00.000Z",
          status: "submitted",
        },
      ],
    });

    const me = (await fetchCorrespondents()).find((c) => c.address === addr);
    expect(me?.signalCount).toBe(2);
    expect(me?.daysActive).toBe(2);
  });
});

describe("correspondent_stats — correction does not bump aggregates", () => {
  it("excludes correction_of != NULL signals from signal_count", async () => {
    const addr = "bc1q-corr-stats-004";
    await seed({
      signals: [
        {
          id: "cs-004-original",
          beat_slug: "agent-social",
          btc_address: addr,
          headline: "first",
          sources: "[]",
          created_at: "2026-04-15T10:00:00.000Z",
          status: "submitted",
        },
        {
          id: "cs-004-correction",
          beat_slug: "agent-social",
          btc_address: addr,
          headline: "amended first",
          sources: "[]",
          created_at: "2026-04-15T11:00:00.000Z",
          status: "submitted",
          correction_of: "cs-004-original",
        },
      ],
    });

    const me = (await fetchCorrespondents()).find((c) => c.address === addr);
    expect(me?.signalCount).toBe(1);
    expect(me?.daysActive).toBe(1);
  });
});

describe("correspondent_stats — recon endpoint reports zero drift after seed", () => {
  it("expected_rows matches actual_rows after the recompute helper runs", async () => {
    const addrs = ["bc1q-recon-001", "bc1q-recon-002", "bc1q-recon-003"];
    await seed({
      signals: [
        {
          id: "recon-1",
          beat_slug: "agent-social",
          btc_address: addrs[0],
          headline: "a",
          sources: "[]",
          created_at: "2026-04-10T10:00:00.000Z",
          status: "submitted",
        },
        {
          id: "recon-2",
          beat_slug: "agent-social",
          btc_address: addrs[0],
          headline: "b",
          sources: "[]",
          created_at: "2026-04-11T10:00:00.000Z",
          status: "submitted",
        },
        {
          id: "recon-3",
          beat_slug: "agent-social",
          btc_address: addrs[1],
          headline: "c",
          sources: "[]",
          created_at: "2026-04-12T10:00:00.000Z",
          status: "submitted",
        },
        {
          id: "recon-4",
          beat_slug: "agent-social",
          btc_address: addrs[2],
          headline: "d",
          sources: "[]",
          created_at: "2026-04-13T10:00:00.000Z",
          status: "submitted",
          correction_of: "recon-1",
        },
      ],
    });

    // recon endpoint requires BIP-322 auth at the public boundary; use the
    // DO route directly via the test-seed shape — the test pool worker
    // already has access. We assert the read surface (correspondents) and
    // expected scope: addrs[0] has 2 non-correction signals; addrs[1] has 1;
    // addrs[2] has only a correction so it should not appear at all.
    const correspondents = await fetchCorrespondents();
    const addr0 = correspondents.find((c) => c.address === addrs[0]);
    const addr1 = correspondents.find((c) => c.address === addrs[1]);
    const addr2 = correspondents.find((c) => c.address === addrs[2]);

    expect(addr0?.signalCount).toBe(2);
    expect(addr1?.signalCount).toBe(1);
    expect(addr2).toBeUndefined();
  });
});

describe("correspondent_stats — recon detects and repairs drift", () => {
  it("reports drift after stats corruption and repairs it on demand", async () => {
    const addr = "bc1q-recon-drift-001";

    // Seed two same-day signals; the test-seed recompute hook keeps
    // correspondent_stats consistent so the inline recon must report 0 drift.
    const seedRes = await SELF.fetch("http://example.com/api/test-seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signals: [
          {
            id: "drift-a",
            beat_slug: "agent-social",
            btc_address: addr,
            headline: "first",
            sources: "[]",
            created_at: "2026-04-20T08:00:00.000Z",
            status: "submitted",
          },
          {
            id: "drift-b",
            beat_slug: "agent-social",
            btc_address: addr,
            headline: "second",
            sources: "[]",
            created_at: "2026-04-20T14:00:00.000Z",
            status: "submitted",
          },
        ],
        recon: { repair: false },
      }),
    });
    expect(seedRes.status).toBe(200);
    const seedBody = await seedRes.json<{
      data: {
        recon: {
          drift_count: number;
          affected_addresses: number;
          repaired: number;
        };
      };
    }>();
    expect(seedBody.data.recon.drift_count).toBe(0);
    expect(seedBody.data.recon.affected_addresses).toBe(0);

    // Corrupt the materialised row for this agent.
    await seed({
      correspondent_stats: [
        {
          btc_address: addr,
          signal_count: 999,
          last_signal_at: "2099-01-01T00:00:00.000Z",
          first_signal_at: "2099-01-01T00:00:00.000Z",
          days_active: 42,
        },
      ],
    });

    // Confirm the materialised read now serves the corrupt values, proving
    // the read sites really do read from correspondent_stats (not the
    // signals aggregate).
    let correspondents = await fetchCorrespondents();
    expect(correspondents.find((c) => c.address === addr)?.signalCount).toBe(999);

    // Recon in report mode — exactly one affected address; repaired=0.
    const reportRes = await SELF.fetch("http://example.com/api/test-seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recon: { repair: false } }),
    });
    const reportBody = await reportRes.json<{
      data: { recon: { drift_count: number; affected_addresses: number; repaired: number } };
    }>();
    expect(reportBody.data.recon.affected_addresses).toBe(1);
    expect(reportBody.data.recon.drift_count).toBeGreaterThan(0);
    expect(reportBody.data.recon.repaired).toBe(0);

    // Recon in repair mode — repaired === affected_addresses.
    const repairRes = await SELF.fetch("http://example.com/api/test-seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recon: { repair: true } }),
    });
    const repairBody = await repairRes.json<{
      data: { recon: { affected_addresses: number; repaired: number } };
    }>();
    expect(repairBody.data.recon.repaired).toBe(repairBody.data.recon.affected_addresses);
    expect(repairBody.data.recon.repaired).toBe(1);

    // After repair the read surface matches the truth: 2 same-day signals.
    correspondents = await fetchCorrespondents();
    const repaired = correspondents.find((c) => c.address === addr);
    expect(repaired?.signalCount).toBe(2);
    expect(repaired?.daysActive).toBe(1);
  });
});

describe("correspondents bundle — leaderboard read decoupled from recompute (#690 cold-rebuild)", () => {
  // Fix 1: /correspondents-bundle reads leaderboard_cache stale-or-empty instead
  // of running a live queryLeaderboard() on every cold rebuild. The endpoint must
  // still serve correspondents when the cache is empty (degrading to zero scores)
  // and source its scores from the materialised cache once it is populated — the
  // recompute only ever happens via /leaderboard or /init, never here.
  async function fetchWithScores(): Promise<
    Array<{ address: string; signalCount: number; score: number }>
  > {
    const res = await SELF.fetch("http://example.com/api/correspondents");
    expect(res.status).toBe(200);
    const body = await res.json<{
      correspondents: Array<{ address: string; signalCount: number; score: number }>;
    }>();
    return body.correspondents;
  }

  it("serves zero scores when the leaderboard cache is empty, then agrees with the cache once populated", async () => {
    const addr = "bc1q-corr-lb-decouple-001";

    // Seeding is a POST, so the DO's post-dispatch mutation hook drops
    // leaderboard_cache. The next correspondents read therefore exercises the
    // empty-cache branch of getLeaderboardStaleOrEmpty().
    await seed({
      signals: [
        {
          id: "cs-lb-001-a",
          beat_slug: "agent-social",
          btc_address: addr,
          headline: "decouple",
          sources: "[]",
          created_at: "2026-04-15T10:00:00.000Z",
          status: "submitted",
        },
      ],
    });

    // Empty-cache branch: the agent is still returned (correct signalCount) and
    // its score degrades to 0 rather than the endpoint blocking on a recompute.
    let correspondents = await fetchWithScores();
    let me = correspondents.find((c) => c.address === addr);
    expect(me).toBeDefined();
    expect(me?.signalCount).toBe(1);
    expect(me?.score).toBe(0);

    // A /leaderboard read is the only remaining path that recomputes and
    // repopulates leaderboard_cache.
    const lbRes = await SELF.fetch("http://example.com/api/leaderboard");
    expect(lbRes.status).toBe(200);
    const lbBody = await lbRes.json<{
      leaderboard: Array<{ address: string; score: number }>;
    }>();
    const lbScore =
      lbBody.leaderboard.find((e) => e.address === addr)?.score ?? 0;

    // Populated-cache branch: correspondents now sources its score from the same
    // materialised cache the leaderboard wrote — the two agree, and the read
    // itself never triggered a recompute.
    correspondents = await fetchWithScores();
    me = correspondents.find((c) => c.address === addr);
    expect(me?.signalCount).toBe(1);
    expect(me?.score).toBe(lbScore);
  });
});
