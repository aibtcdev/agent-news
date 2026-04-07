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

  it("enforces the 30-signal cap and reconciles replaced status, brief_signals, and payouts on recompile", async () => {
    const date = "2026-04-11";
    const signals = [];
    const briefSignals = [];
    for (let i = 0; i < 31; i++) {
      const id = `over-cap-${i.toString().padStart(2, "0")}`;
      signals.push({
        id,
        beat_slug: i % 2 === 0 ? "agent-social" : "agent-economy",
        btc_address: i % 2 === 0 ? REPORTER_A : REPORTER_B,
        headline: `Overflow candidate ${i}`,
        sources: "[]",
        created_at: `2026-04-11T12:${i.toString().padStart(2, "0")}:00Z`,
        status: "brief_included",
        reviewed_at: `2026-04-11T23:${i.toString().padStart(2, "0")}:00Z`,
      });
      briefSignals.push({
        brief_date: date,
        signal_id: id,
        btc_address: i % 2 === 0 ? REPORTER_A : REPORTER_B,
        position: i,
        created_at: "2026-04-11T23:59:00Z",
      });
    }

    await seed({
      signals,
      brief_signals: briefSignals,
      earnings: [
        {
          id: "earning-overflow-00",
          btc_address: REPORTER_A,
          amount_sats: 30000,
          reason: "brief_inclusion",
          reference_id: "over-cap-00",
          created_at: "2026-04-11T23:59:30Z",
        },
      ],
    });

    const firstCompileRes = await compile(date);
    expect(firstCompileRes.status).toBe(201);
    const firstCompile = await firstCompileRes.json<{
      brief: {
        included_signal_ids: string[];
        included_signals: Array<{ signal_id: string; position: number }>;
        roster: { candidate_count: number; selected_count: number; overflow_count: number };
      };
      payouts: { paid: number; skipped: number; revived: number; voided: number };
    }>();

    // Simplified compile orders by reviewed_at DESC — most recently reviewed first.
    // With 31 signals (reviewed_at 23:00-23:30), signal 30 (latest) is first,
    // signal 00 (earliest) is the overflow candidate dropped at the 30-signal cap.
    expect(firstCompile.brief.included_signal_ids).toHaveLength(30);
    expect(firstCompile.brief.included_signal_ids[0]).toBe("over-cap-30");
    expect(firstCompile.brief.included_signal_ids[29]).toBe("over-cap-01");
    expect(firstCompile.brief.roster).toEqual(expect.objectContaining({
      candidate_count: 31,
      selected_count: 30,
      overflow_count: 1,
    }));
    expect(firstCompile.payouts).toEqual({
      paid: 30,
      skipped: 0,
      revived: 0,
      voided: 1,
    });

    const briefSignalsRes = await SELF.fetch(`http://example.com/api/test/brief-signals/${date}`);
    expect(briefSignalsRes.status).toBe(200);
    const briefSignalsBody = await briefSignalsRes.json<{ ok: true; data: Array<{ signal_id: string }> }>();
    expect(briefSignalsBody.data).toHaveLength(30);
    expect(briefSignalsBody.data.some((row) => row.signal_id === "over-cap-00")).toBe(false);

    const replacedRes = await SELF.fetch(`http://example.com/api/signals?date=${date}&status=replaced`);
    expect(replacedRes.status).toBe(200);
    const replacedBody = await replacedRes.json<{ signals: Array<{ id: string }> }>();
    expect(replacedBody.signals.map((signal) => signal.id)).toContain("over-cap-00");

    const curatedRes = await SELF.fetch("http://example.com/api/front-page");
    expect(curatedRes.status).toBe(200);
    const curatedBody = await curatedRes.json<{ signals: Array<{ id: string }> }>();
    expect(curatedBody.signals.some((signal) => signal.id === "over-cap-00")).toBe(false);

    const secondCompileRes = await compile(date);
    expect(secondCompileRes.status).toBe(201);
    const secondCompile = await secondCompileRes.json<{
      brief: { included_signal_ids: string[]; roster: { candidate_count: number; overflow_count: number } };
      payouts: { paid: number; skipped: number; revived: number; voided: number };
    }>();
    expect(secondCompile.brief.included_signal_ids).toEqual(firstCompile.brief.included_signal_ids);
    expect(secondCompile.brief.roster).toEqual(expect.objectContaining({
      candidate_count: 30,
      overflow_count: 0,
    }));
    expect(secondCompile.payouts).toEqual({
      paid: 0,
      skipped: 30,
      revived: 0,
      voided: 0,
    });
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
