import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

const COMPILER_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const REPORTER_A = "seed-reporter-a";
const REPORTER_B = "seed-reporter-b";

async function seed(body: Record<string, unknown>) {
  const res = await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

async function compile(date: string) {
  return SELF.fetch("http://example.com/api/test/brief/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ btc_address: COMPILER_ADDRESS, date }),
  });
}

describe("brief compile reconciliation", () => {
  it("persists explicit included roster metadata for under-30 days", async () => {
    const date = "2026-04-10";
    await seed({
      signals: [
        {
          id: "under-30-1",
          beat_slug: "agent-social",
          btc_address: REPORTER_A,
          headline: "Macro signal 1",
          sources: "[]",
          created_at: "2026-04-10T12:00:00Z",
          status: "approved",
          reviewed_at: "2026-04-10T12:30:00Z",
        },
        {
          id: "under-30-2",
          beat_slug: "agent-economy",
          btc_address: REPORTER_B,
          headline: "Economy signal 2",
          sources: "[]",
          created_at: "2026-04-10T13:00:00Z",
          status: "approved",
          reviewed_at: "2026-04-10T13:30:00Z",
        },
        {
          id: "under-30-3",
          beat_slug: "security",
          btc_address: REPORTER_A,
          headline: "Security signal 3",
          sources: "[]",
          created_at: "2026-04-10T14:00:00Z",
          status: "approved",
          reviewed_at: "2026-04-10T14:30:00Z",
        },
      ],
    });

    const res = await compile(date);
    expect(res.status).toBe(201);
    const body = await res.json<{
      brief: {
        included_signal_ids: string[];
        included_signals: Array<{ signal_id: string; position: number }>;
        roster: { candidate_count: number; selected_count: number; overflow_count: number };
      };
    }>();

    expect(body.brief.included_signal_ids).toEqual([
      "under-30-3",
      "under-30-2",
      "under-30-1",
    ]);
    expect(body.brief.included_signals.map((signal) => signal.position)).toEqual([0, 1, 2]);
    expect(body.brief.roster).toEqual(expect.objectContaining({
      candidate_count: 3,
      selected_count: 3,
      overflow_count: 0,
    }));

    const savedRes = await SELF.fetch(`http://example.com/api/brief/${date}`);
    expect(savedRes.status).toBe(200);
    const saved = await savedRes.json<{
      included_signal_ids: string[];
      included_signals: Array<{ signal_id: string; position: number }>;
    }>();
    expect(saved.included_signal_ids).toEqual(body.brief.included_signal_ids);
    expect(saved.included_signals).toEqual(body.brief.included_signals);

    const includedRes = await SELF.fetch(`http://example.com/api/signals?date=${date}&status=brief_included`);
    expect(includedRes.status).toBe(200);
    const includedBody = await includedRes.json<{ signals: Array<{ id: string }> }>();
    expect(includedBody.signals).toHaveLength(3);
  });

  it("rejects compilation when approved signals exceed the brief cap (invariant violation)", async () => {
    const date = "2026-04-11";
    const signals = [];
    for (let i = 0; i < 31; i++) {
      const id = `over-cap-${i.toString().padStart(2, "0")}`;
      signals.push({
        id,
        beat_slug: i % 2 === 0 ? "agent-social" : "agent-economy",
        btc_address: i % 2 === 0 ? REPORTER_A : REPORTER_B,
        headline: `Overflow candidate ${i}`,
        sources: "[]",
        created_at: `2026-04-11T12:${i.toString().padStart(2, "0")}:00Z`,
        status: "approved",
        reviewed_at: `2026-04-11T23:${i.toString().padStart(2, "0")}:00Z`,
      });
    }

    await seed({ signals });

    // Compile should reject: 31 approved signals exceeds MAX_INCLUDED_SIGNALS_PER_BRIEF (30).
    // After review-time caps were aligned to created_at, this overflow should be unreachable
    // in normal operation — this test verifies the compile-time safety net surfaces the error.
    const compileRes = await compile(date);
    expect(compileRes.status).toBe(409);
    const body = await compileRes.json<{ error: string }>();
    expect(body.error).toContain("invariant violated");
    expect(body.error).toContain("31");
  }, 40000);

  it("blocks subtractive recompile after inscription", async () => {
    const date = "2026-04-12";
    await seed({
      signals: [
        {
          id: "locked-1",
          beat_slug: "agent-social",
          btc_address: REPORTER_A,
          headline: "Locked roster 1",
          sources: "[]",
          created_at: "2026-04-12T12:00:00Z",
          status: "brief_included",
        },
        {
          id: "locked-2",
          beat_slug: "agent-economy",
          btc_address: REPORTER_B,
          headline: "Locked roster 2",
          sources: "[]",
          created_at: "2026-04-12T13:00:00Z",
          status: "brief_included",
        },
        {
          id: "locked-3",
          beat_slug: "security",
          btc_address: REPORTER_A,
          headline: "Locked roster 3",
          sources: "[]",
          created_at: "2026-04-12T14:00:00Z",
          status: "brief_included",
        },
        {
          id: "locked-extra",
          beat_slug: "security",
          btc_address: REPORTER_B,
          headline: "Extra active row",
          sources: "[]",
          created_at: "2026-04-12T15:00:00Z",
          status: "replaced",
        },
      ],
      brief_signals: [
        { brief_date: date, signal_id: "locked-1", btc_address: REPORTER_A, position: 0, created_at: "2026-04-12T23:00:00Z" },
        { brief_date: date, signal_id: "locked-2", btc_address: REPORTER_B, position: 1, created_at: "2026-04-12T23:00:00Z" },
        { brief_date: date, signal_id: "locked-3", btc_address: REPORTER_A, position: 2, created_at: "2026-04-12T23:00:00Z" },
        { brief_date: date, signal_id: "locked-extra", btc_address: REPORTER_B, position: 3, created_at: "2026-04-12T23:00:00Z" },
      ],
      briefs: [
        {
          date,
          text: "locked",
          json_data: "{}",
          compiled_at: "2026-04-12T23:30:00Z",
          inscription_id: "inscription-123",
          inscribed_txid: "txid-123",
        },
      ],
    });

    const res = await compile(date);
    expect(res.status).toBe(409);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("Cannot remove included signals after the brief has been inscribed");
  });
});
