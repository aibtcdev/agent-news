/**
 * Regression guard for #832 — /status/:address returned a contradictory
 * `beatStatus: "inactive"` alongside `canFileSignal: true` for agents who
 * registered on a since-retired beat but migrated to an active one.
 *
 * The backward-compat `beat`/`beatStatus` fields blindly exposed the agent's
 * oldest claim (ORDER BY claimed_at), which for the pre-consolidation cohort was
 * a retired beat with no recent activity — reading "inactive" while the filing
 * gate said they could file. These tests assert the display field now tracks the
 * agent's fileable beat, and that an all-retired agent is not told they can file.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { Env } from "../lib/types";

const testEnv = env as unknown as Env;

interface StatusBody {
  data: {
    beat: { slug: string; beatStatus: string; retired: boolean } | null;
    beatStatus: string | null;
    canFileSignal: boolean;
    beats: Array<{ slug: string; beatStatus: string; retired: boolean }>;
    actions: Array<{ type: string; description: string }>;
  };
}

async function seed(stub: DurableObjectStub, fn: (sql: SqlStorage) => void) {
  await runInDurableObject(stub, (_instance, state) => fn(state.storage.sql));
}

describe("/status beat/canFileSignal consistency (#832)", () => {
  it("surfaces the active beat (not the oldest retired claim) as `beat`", async () => {
    const id = testEnv.NEWS_DO.idFromName("news-singleton");
    const stub = testEnv.NEWS_DO.get(id);
    const agent = "bc1qmigrated00000000000000000000000000000";
    const now = new Date().toISOString();
    const older = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();

    await seed(stub, (sql) => {
      // A now-retired beat the agent claimed first (no recent activity)...
      sql.exec(
        "INSERT OR IGNORE INTO beats (slug, name, created_by, created_at, updated_at, status) VALUES ('deal-flow-832', 'Deal Flow', 'creator', ?, ?, 'retired')",
        older,
        older
      );
      sql.exec(
        "INSERT OR IGNORE INTO beat_claims (beat_slug, btc_address, claimed_at, status) VALUES ('deal-flow-832', ?, ?, 'active')",
        agent,
        older // claimed first → would be agentBeats[0] under the old code
      );
      // ...and an active beat they migrated to and file on.
      sql.exec(
        "INSERT OR IGNORE INTO beats (slug, name, created_by, created_at, updated_at) VALUES ('aibtc-network-832', 'AIBTC Network', 'creator', ?, ?)",
        now,
        now
      );
      sql.exec(
        "INSERT OR IGNORE INTO beat_claims (beat_slug, btc_address, claimed_at, status) VALUES ('aibtc-network-832', ?, ?, 'active')",
        agent,
        now
      );
      // Recent beat activity from another author keeps the beat `active` without
      // putting *this* agent in signal cooldown (so canFileSignal stays true).
      sql.exec(
        `INSERT OR IGNORE INTO signals
           (id, beat_slug, btc_address, headline, sources, created_at, updated_at, status, correction_of)
         VALUES ('sig-832-live', 'aibtc-network-832', 'bc1qother0000000000000000000000000000000', 'live signal', '[]', ?, ?, 'approved', NULL)`,
        now,
        now
      );
    });

    const res = await stub.fetch(`https://do/status/${agent}`);
    const { data } = (await res.json()) as StatusBody;

    // The exposed beat is the active, non-retired one — no contradiction.
    expect(data.beat?.slug).toBe("aibtc-network-832");
    expect(data.beat?.retired).toBe(false);
    expect(data.beatStatus).toBe("active");
    expect(data.canFileSignal).toBe(true);
    // Both claims still visible in the full array.
    expect(data.beats.map((b) => b.slug).sort()).toEqual([
      "aibtc-network-832",
      "deal-flow-832",
    ]);
  });

  it("does not report canFileSignal=true when every claimed beat is retired", async () => {
    const id = testEnv.NEWS_DO.idFromName("news-singleton");
    const stub = testEnv.NEWS_DO.get(id);
    const agent = "bc1qretiredonly000000000000000000000000000";
    const older = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();

    await seed(stub, (sql) => {
      sql.exec(
        "INSERT OR IGNORE INTO beats (slug, name, created_by, created_at, updated_at, status) VALUES ('agent-economy-832', 'Agent Economy', 'creator', ?, ?, 'retired')",
        older,
        older
      );
      sql.exec(
        "INSERT OR IGNORE INTO beat_claims (beat_slug, btc_address, claimed_at, status) VALUES ('agent-economy-832', ?, ?, 'active')",
        agent,
        older
      );
    });

    const res = await stub.fetch(`https://do/status/${agent}`);
    const { data } = (await res.json()) as StatusBody;

    // Retired-only agent genuinely cannot file (POST rejects retired beats).
    expect(data.canFileSignal).toBe(false);
    expect(data.actions.some((a) => a.type === "claim-beat")).toBe(true);
  });
});
