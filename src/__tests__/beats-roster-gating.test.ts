/**
 * Guards the /beats member-roster gating.
 *
 * The DO /beats handler fetches the full active-member roster (thousands of rows
 * across all beats) only when ?include=members is requested; the default path
 * returns per-beat `member_count` instead, so the hot /api/beats endpoint does
 * not materialise every claim just to report a count.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { Env } from "../lib/types";

const testEnv = env as unknown as Env;

interface BeatRow {
  slug: string;
  member_count?: number;
  members?: unknown[];
}

describe("/beats member-roster gating", () => {
  it("default returns member_count only; include=members returns the roster", async () => {
    const id = testEnv.NEWS_DO.idFromName("news-singleton");
    const stub = testEnv.NEWS_DO.get(id);
    const MEMBERS = 7;

    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const now = new Date().toISOString();
      sql.exec(
        "INSERT OR IGNORE INTO beats (slug, name, created_by, created_at, updated_at) VALUES ('roster-beat', 'Roster', 'creator', ?, ?)",
        now,
        now
      );
      for (let m = 0; m < MEMBERS; m++) {
        sql.exec(
          "INSERT OR IGNORE INTO beat_claims (beat_slug, btc_address, claimed_at, status) VALUES ('roster-beat', ?, ?, 'active')",
          `bc1qroster${String(m).padStart(30, "0")}`,
          now
        );
      }
    });

    // Default: count present, full roster omitted.
    const defRes = await stub.fetch("https://do/beats");
    const defBody = (await defRes.json()) as { data: BeatRow[] };
    const defBeat = defBody.data.find((b) => b.slug === "roster-beat");
    expect(defBeat).toBeDefined();
    expect(defBeat?.member_count).toBe(MEMBERS);
    expect(defBeat?.members).toBeUndefined();

    // include=members: full roster present, count still correct.
    const incRes = await stub.fetch("https://do/beats?include=members");
    const incBody = (await incRes.json()) as { data: BeatRow[] };
    const incBeat = incBody.data.find((b) => b.slug === "roster-beat");
    expect(incBeat?.members?.length).toBe(MEMBERS);
    expect(incBeat?.member_count).toBe(MEMBERS);
  });

  it("count query reads fewer rows than the full-roster fetch", async () => {
    const id = testEnv.NEWS_DO.idFromName("news-singleton");
    const stub = testEnv.NEWS_DO.get(id);

    const { fullRows, countRows } = (await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const now = new Date().toISOString();
      for (let b = 0; b < 8; b++) {
        sql.exec(
          "INSERT OR IGNORE INTO beats (slug, name, created_by, created_at, updated_at) VALUES (?, ?, 'c', ?, ?)",
          `cntbeat-${b}`,
          `Cnt ${b}`,
          now,
          now
        );
        for (let m = 0; m < 50; m++) {
          sql.exec(
            "INSERT OR IGNORE INTO beat_claims (beat_slug, btc_address, claimed_at, status) VALUES (?, ?, ?, 'active')",
            `cntbeat-${b}`,
            `bc1qcnt${b}_${String(m).padStart(28, "0")}`,
            now
          );
        }
      }
      sql.exec("ANALYZE");

      const full = sql.exec(
        "SELECT beat_slug, btc_address, claimed_at, status FROM beat_claims WHERE status='active' ORDER BY claimed_at"
      );
      full.toArray();
      const fullRows = full.rowsRead;

      const cnt = sql.exec(
        "SELECT beat_slug, COUNT(*) as member_count FROM beat_claims WHERE status='active' GROUP BY beat_slug"
      );
      cnt.toArray();
      const countRows = cnt.rowsRead;
      return { fullRows, countRows };
    })) as { fullRows: number; countRows: number };

    console.log(`[roster] full-roster rowsRead=${fullRows}, count rowsRead=${countRows}`);
    // The default count path must read strictly fewer rows than fetching the
    // full roster (it skips the table read + sort via an index-only scan).
    expect(countRows).toBeLessThan(fullRows);
  });
});
