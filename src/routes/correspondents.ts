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

  // Build address → leaderboard score map and earnings map
  const scoreMap = new Map<string, number>();
  const earningsMap = new Map<string, number>();
  for (const entry of leaderboardEntries) {
    scoreMap.set(entry.btc_address, Number(entry.score));
    earningsMap.set(entry.btc_address, Number(entry.total_earned_sats));
  }

  const beatsByAddress = buildBeatsByAddress(beats, bundle.claims);
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
    const score = scoreMap.get(row.btc_address) ?? 0;
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
      earnings: { total: earningsMap.get(row.btc_address) ?? 0, recentPayments: [] as unknown[] },
      display_name: info?.name ?? null,
      avatar: `https://bitcoinfaces.xyz/api/get-image?name=${encodeURIComponent(avatarAddr)}`,
      registered: info?.name !== null && info?.name !== undefined,
    };
  });

  // Sort by score descending, then streak, then address to mirror
  // leaderboard tie-breaking when signal_count order diverges after a reset.
  correspondents.sort(
    (a, b) =>
      b.score - a.score ||
      b.streak - a.streak ||
      a.address.localeCompare(b.address),
  );

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({ correspondents, total: correspondents.length });
});

export { correspondentsRouter };
