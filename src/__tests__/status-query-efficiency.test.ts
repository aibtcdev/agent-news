/**
 * Regression guard for the /status/:address beat-activity query.
 *
 * The beats-membership query computes each beat's last-activity timestamp. The
 * original form joined every active member of every beat to their signals purely
 * to derive one MAX per beat, so it read O(members × signals) rows per call — at
 * ~25 uncached /status calls/min this was the single largest driver of the DO's
 * SQLite rows-read bill. The current form uses a per-beat correlated MAX backed
 * by idx_signals_beat_created, reading ~O(beats) rows.
 *
 * This test seeds a realistically large beat and asserts the live query reads a
 * bounded number of rows regardless of how many members/signals the beat has.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { NewsDO } from "../objects/news-do";

describe("/status beat-activity query efficiency", () => {
  it("reads O(beats) rows, not O(members × signals)", async () => {
    const id = env.NEWS_DO.idFromName("news-singleton");
    const stub = env.NEWS_DO.get(id);

    const result = await runInDurableObject(stub, (_instance: NewsDO, state) => {
      const sql = state.storage.sql;
      const now = new Date().toISOString();
      const beat = "measure-beat";
      const me = "bc1qme000000000000000000000000000000000000";
      const MEMBERS = 150;
      const PER = 15; // signals per member

      sql.exec(
        "INSERT OR IGNORE INTO beats (slug, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        beat,
        "Measure Beat",
        "creator",
        now,
        now
      );

      for (let m = 0; m < MEMBERS; m++) {
        const addr = m === 0 ? me : `bc1qmember${String(m).padStart(31, "0")}`;
        sql.exec(
          "INSERT OR IGNORE INTO beat_claims (beat_slug, btc_address, claimed_at, status) VALUES (?, ?, ?, 'active')",
          beat,
          addr,
          now
        );
        for (let s = 0; s < PER; s++) {
          sql.exec(
            `INSERT OR IGNORE INTO signals
               (id, beat_slug, btc_address, headline, sources, created_at, updated_at, status, correction_of)
             VALUES (?, ?, ?, ?, '[]', ?, ?, 'approved', NULL)`,
            `sig-${m}-${s}`,
            beat,
            addr,
            `headline ${m}-${s}`,
            new Date(Date.now() - (m * PER + s) * 60_000).toISOString(),
            now
          );
        }
      }

      // Mirror production's planner: with table stats present, the outer
      // `beat_claims WHERE btc_address = ?` uses idx_beat_claims_address (a point
      // lookup) rather than scanning the tiny seeded table.
      sql.exec("ANALYZE");

      // OLD form — member fan-out (kept here only to quantify the contrast).
      const oldCursor = sql.exec(
        `SELECT b.*, MAX(s.created_at) as last_signal_at
         FROM beat_claims bc
         JOIN beats b ON bc.beat_slug = b.slug
         LEFT JOIN beat_claims bc_all ON b.slug = bc_all.beat_slug AND bc_all.status = 'active'
         LEFT JOIN signals s ON bc_all.btc_address = s.btc_address
           AND s.beat_slug = b.slug
           AND s.correction_of IS NULL
         WHERE bc.btc_address = ? AND bc.status = 'active'
         GROUP BY b.slug
         ORDER BY bc.claimed_at`,
        me
      );
      const oldRowsData = oldCursor.toArray();
      const oldRows = oldCursor.rowsRead;

      // NEW form — per-beat correlated MAX (what /status now runs).
      const newCursor = sql.exec(
        `SELECT b.*, (
           SELECT MAX(s.created_at)
           FROM signals s
           WHERE s.beat_slug = b.slug
             AND s.correction_of IS NULL
         ) AS last_signal_at
         FROM beat_claims bc
         JOIN beats b ON bc.beat_slug = b.slug
         WHERE bc.btc_address = ? AND bc.status = 'active'
         ORDER BY bc.claimed_at`,
        me
      );
      const newRowsData = newCursor.toArray();
      const newRows = newCursor.rowsRead;

      return {
        oldRows,
        newRows,
        members: MEMBERS,
        signals: MEMBERS * PER,
        // Both forms must return the same beat with the same last-activity value.
        sameLastSignal:
          (oldRowsData[0] as { last_signal_at: string }).last_signal_at ===
          (newRowsData[0] as { last_signal_at: string }).last_signal_at,
        beatCount: newRowsData.length,
      };
    });

    console.log(
      `[status query] members=${result.members} signals=${result.signals} → OLD rowsRead=${result.oldRows}, NEW rowsRead=${result.newRows}`
    );

    // The agent belongs to exactly one seeded beat.
    expect(result.beatCount).toBe(1);
    // Equivalent result (last activity in the beat is unchanged).
    expect(result.sameLastSignal).toBe(true);
    // The new form must read dramatically fewer rows than the fan-out...
    expect(result.newRows).toBeLessThan(result.oldRows / 5);
    // ...and its cost must NOT scale with the number of signals in the beat —
    // the whole point of the rewrite. With 2,250 signals seeded, reading well
    // under that (bounded by the agent's beat membership) proves the per-beat
    // signal fan-out is gone.
    expect(result.newRows).toBeLessThan(result.signals / 10);
  });
});
