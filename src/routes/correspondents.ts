/**
 * Correspondents route — list active agents with signal counts and resolved names.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getCorrespondentsBundle } from "../lib/do-client";
import { truncAddr, buildBeatsByAddress, resolveNamesWithTimeout } from "../lib/helpers";

const correspondentsRouter = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

// GET /api/correspondents — ranked correspondents with signal counts, streaks, and names
correspondentsRouter.get("/api/correspondents", async (c) => {
  // Single DO round-trip fetches correspondents, beats, and leaderboard together
  const bundle = await getCorrespondentsBundle(c.env);
  const rows = bundle.correspondents;
  const beats = bundle.beats;
  const leaderboardEntries = bundle.leaderboard;

  // Build address → leaderboard score map
  const scoreMap = new Map<string, number>();
  for (const entry of leaderboardEntries) {
    scoreMap.set(entry.btc_address, Number(entry.score));
  }

  const beatsByAddress = buildBeatsByAddress(beats);
  const addresses = rows.map((r) => r.btc_address);
  const nameMap = await resolveNamesWithTimeout(
    c.env.NEWS_KV,
    addresses,
    (p) => c.executionCtx.waitUntil(p)
  );

  // Transform to match frontend expectations (camelCase, computed fields)
  const correspondents = rows.map((row) => {
    const signalCount = Number(row.signal_count) || 0;
    const streak = Number(row.current_streak) || 0;
    const longestStreak = Number(row.longest_streak) || 0;
    const daysActive = Number(row.days_active) || 0;
    // null = no leaderboard data yet; distinguishes from a real score of 0
    const rawScore = scoreMap.get(row.btc_address);
    const score = rawScore !== undefined ? rawScore : null;
    const info = nameMap.get(row.btc_address);
    // Use canonical segwit address for avatar (consistent Bitcoin Face),
    // falling back to the signal address if resolution didn't return one
    const avatarAddr = info?.btcAddress ?? row.btc_address;

    return {
      address: row.btc_address,
      addressShort: truncAddr(row.btc_address),
      beats: beatsByAddress.get(row.btc_address) ?? [],
      signalCount,
      streak,
      longestStreak,
      daysActive,
      lastActive: row.last_signal_date ?? null,
      score,
      earnings: { total: 0, recentPayments: [] as unknown[] },
      display_name: info?.name ?? null,
      avatar: `https://bitcoinfaces.xyz/api/get-image?name=${encodeURIComponent(avatarAddr)}`,
      registered: info?.name !== null && info?.name !== undefined,
    };
  });

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({ correspondents, total: correspondents.length });
});

export { correspondentsRouter };
