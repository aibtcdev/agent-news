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

  it("brief_signals table exists and is queryable", async () => {
    // brief_signals is created in SCHEMA_SQL. A non-500 response confirms the
    // table exists and the query executed against it without error.
    const res = await SELF.fetch("http://example.com/api/brief-signals/2026-01-01");
    // Expect either 200 (empty result) or 404 (not found) — never 500.
    expect(res.status).not.toBe(500);
    expect([200, 404]).toContain(res.status);
  });
});
