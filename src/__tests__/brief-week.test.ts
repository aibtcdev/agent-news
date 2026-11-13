import { describe, it, expect } from "vitest";
import { SELF, env } from "cloudflare:test";
import { saveBrief, updateBrief } from "../lib/do-client";
import type { Env } from "../lib/types";

const testEnv = env as unknown as Env;

const ADDR_A = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const ADDR_B = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";

async function seedDailyBrief(
  date: string,
  includedSignals: Array<{
    signal_id: string;
    position: number;
    btc_address: string;
    beat_slug: string;
    headline: string;
    created_at: string;
  }>,
  inscriptionId?: string
) {
  const saved = await saveBrief(testEnv, {
    date,
    text: `Brief for ${date}`,
    json_data: JSON.stringify({
      date,
      compiled_at: `${date}T01:00:00.000Z`,
      summary: {
        correspondents: new Set(includedSignals.map((s) => s.btc_address)).size,
        beats: new Set(includedSignals.map((s) => s.beat_slug)).size,
        signals: includedSignals.length,
      },
      included_signal_ids: includedSignals.map((s) => s.signal_id),
      included_signals: includedSignals,
      sections: [],
    }),
    compiled_at: `${date}T01:00:00.000Z`,
  });
  expect(saved.ok).toBe(true);
  if (inscriptionId) {
    const updated = await updateBrief(testEnv, date, {
      inscription_id: inscriptionId,
      inscribed_txid: inscriptionId.slice(0, 64),
    });
    expect(updated.ok).toBe(true);
  }
}

describe("GET /api/brief/week/:week_iso (#898)", () => {
  it("returns 400 on invalid week_iso format or non-existent calendar date", async () => {
    const badFormat = await SELF.fetch("http://example.com/api/brief/week/not-a-date");
    expect(badFormat.status).toBe(400);

    const rolloverDate = await SELF.fetch("http://example.com/api/brief/week/2026-02-31");
    expect(rolloverDate.status).toBe(400);
  });

  it("reduces 7 daily briefs into entries grouped by btc_address, total_signals, and daily_briefs", async () => {
    const insc1 = `${"1".repeat(64)}i0`;
    await seedDailyBrief(
      "2026-07-20",
      [
        {
          signal_id: "sig-1",
          position: 0,
          btc_address: ADDR_A,
          beat_slug: "quantum",
          headline: "Signal 1",
          created_at: "2026-07-20T10:00:00Z",
        },
        {
          signal_id: "sig-2",
          position: 1,
          btc_address: ADDR_A,
          beat_slug: "aibtc-network",
          headline: "Signal 2",
          created_at: "2026-07-20T11:00:00Z",
        },
        {
          signal_id: "sig-3",
          position: 2,
          btc_address: ADDR_B,
          beat_slug: "bitcoin-macro",
          headline: "Signal 3",
          created_at: "2026-07-20T12:00:00Z",
        },
      ],
      insc1
    );

    await seedDailyBrief("2026-07-22", [
      {
        signal_id: "sig-4",
        position: 0,
        btc_address: ADDR_A,
        beat_slug: "aibtc-network",
        headline: "Signal 4",
        created_at: "2026-07-22T09:00:00Z",
      },
    ]);

    // Outside the 7-day window (2026-07-20 .. 2026-07-26) — must be excluded
    await seedDailyBrief("2026-07-27", [
      {
        signal_id: "sig-outside",
        position: 0,
        btc_address: ADDR_B,
        beat_slug: "quantum",
        headline: "Outside week",
        created_at: "2026-07-27T09:00:00Z",
      },
    ]);

    const res = await SELF.fetch("http://example.com/api/brief/week/2026-07-20");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      week: string;
      first_date: string;
      last_date: string;
      entries: Array<{
        btc_address: string;
        displayName: string | null;
        signal_count: number;
        beats: string[];
      }>;
      total_signals: number;
      daily_briefs: Array<{
        date: string;
        inscription_id: string | null;
        included_count: number;
      }>;
    };

    expect(body.week).toBe("2026-07-20");
    expect(body.first_date).toBe("2026-07-20");
    expect(body.last_date).toBe("2026-07-26");
    expect(body.total_signals).toBe(4);
    expect(body.daily_briefs).toEqual([
      { date: "2026-07-20", inscription_id: insc1, included_count: 3 },
      { date: "2026-07-22", inscription_id: null, included_count: 1 },
    ]);
    expect(body.entries).toEqual([
      {
        btc_address: ADDR_A,
        displayName: null,
        signal_count: 3,
        beats: ["aibtc-network", "quantum"],
      },
      {
        btc_address: ADDR_B,
        displayName: null,
        signal_count: 1,
        beats: ["bitcoin-macro"],
      },
    ]);
  });
});
