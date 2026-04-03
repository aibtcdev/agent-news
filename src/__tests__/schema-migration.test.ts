import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * Migration-path tests that verify the DO constructor correctly runs
 * SCHEMA_SQL and MIGRATION_PHASE0_SQL without crashing.
 *
 * Each test exercises a fresh simnet instance, so the DO constructor
 * runs on the first request in each test. Passing these tests confirms:
 *   - SCHEMA_SQL is valid and creates all expected tables
 *   - MIGRATION_PHASE0_SQL applies cleanly (columns + index after schema init)
 *   - Re-running migrations (duplicate column) is handled gracefully
 */
describe("DO constructor: schema initialization", () => {
  it("initializes without crash — GET /api/beats returns 200", async () => {
    // The DO constructor runs SCHEMA_SQL + MIGRATION_PHASE0_SQL on first access.
    // A 200 response proves the constructor completed without throwing.
    const res = await SELF.fetch("http://example.com/api/beats");
    expect(res.status).toBe(200);
    const body = await res.json<unknown[]>();
    expect(Array.isArray(body)).toBe(true);
  });

  it("signals table has status column — GET /api/signals returns 200", async () => {
    // The status column is added by MIGRATION_PHASE0_SQL. If migration failed,
    // any query touching the signals table would throw a 500.
    const res = await SELF.fetch("http://example.com/api/signals");
    expect(res.status).toBe(200);
    const body = await res.json<{ signals: unknown[]; total: number; filtered: number }>();
    expect(Array.isArray(body.signals)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  it("status filter query executes without error", async () => {
    // Verifies the idx_signals_status index (created in MIGRATION_PHASE0_SQL)
    // was applied correctly and the status column is queryable.
    const res = await SELF.fetch("http://example.com/api/signals?status=approved");
    expect(res.status).toBe(200);
    const body = await res.json<{ signals: unknown[] }>();
    expect(Array.isArray(body.signals)).toBe(true);
  });

  it("briefs table exists and is queryable", async () => {
    // briefs is created in SCHEMA_SQL (along with brief_signals).
    // A 200 response confirms the tables exist and queries execute without error.
    // Note: /api/brief-signals is a DO-internal route with no worker proxy,
    // so we test via /api/brief which queries the briefs table in the DO.
    const res = await SELF.fetch("http://example.com/api/brief");
    expect(res.status).toBe(200);
  });

  it("beat migrations populate 12 canonical beats", async () => {
    // MIGRATION_BEAT_NETWORK_FOCUS_SQL reduces 17 beats to 10 network-focused beats.
    // MIGRATION_BITCOIN_MACRO_SQL (migration 12) re-adds bitcoin-macro → 11.
    // MIGRATION_QUANTUM_BEAT_SQL (migration 13) adds quantum → 12.
    const res = await SELF.fetch("http://example.com/api/beats");
    expect(res.status).toBe(200);
    const body = await res.json<{ slug: string; name: string; dailyApprovedLimit?: number | null }[]>();
    expect(body.length).toBe(12);
    const slugs = body.map((b) => b.slug);
    // Network-focused beats (migration 11)
    expect(slugs).toContain("agent-economy");
    expect(slugs).toContain("agent-trading");
    expect(slugs).toContain("agent-social");
    expect(slugs).toContain("agent-skills");
    expect(slugs).toContain("security");
    expect(slugs).toContain("deal-flow");
    expect(slugs).toContain("onboarding");
    expect(slugs).toContain("governance");
    expect(slugs).toContain("distribution");
    expect(slugs).toContain("infrastructure");
    // Re-added beat (migration 12)
    expect(slugs).toContain("bitcoin-macro");
    // New beat (migration 13)
    expect(slugs).toContain("quantum");
    // Capped beats have dailyApprovedLimit set
    const macrobeat = body.find((b) => b.slug === "bitcoin-macro");
    expect(macrobeat?.dailyApprovedLimit).toBe(4);
    const quantumBeat = body.find((b) => b.slug === "quantum");
    expect(quantumBeat?.dailyApprovedLimit).toBe(4);
    // Network-focused beats have no cap
    const agentEconomy = body.find((b) => b.slug === "agent-economy");
    expect(agentEconomy?.dailyApprovedLimit).toBeNull();
    // Other previously-removed beats should not be present
    expect(slugs).not.toContain("bitcoin-culture");
    expect(slugs).not.toContain("bitcoin-yield");
    expect(slugs).not.toContain("ordinals");
    expect(slugs).not.toContain("runes");
    expect(slugs).not.toContain("art");
    expect(slugs).not.toContain("world-intel");
    expect(slugs).not.toContain("comics");
    // Renamed beats should not be present under old names
    expect(slugs).not.toContain("aibtc-network");
    expect(slugs).not.toContain("dao-watch");
    expect(slugs).not.toContain("dev-tools");
  });
});
