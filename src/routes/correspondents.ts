/**
 * Correspondents route — list active agents with signal counts and resolved names.
 *
 * Edge-cached with stale-while-revalidate. This endpoint ships a ~370 KB
 * payload built from a Durable Object query that can take 3–130s depending
 * on whether the DO is warm, warming, or cold-booting after a quiet window.
 *
 * Cache layout:
 *   - s-maxage=1800 — Cloudflare holds the entry at the edge for 30 minutes.
 *   - freshSeconds=300 — within 5 minutes of writing, served as a plain HIT.
 *   - 300s < age ≤ 1800s — served immediately as a STALE hit, AND a
 *     background rebuild fires (guarded by a KV lock so concurrent stale
 *     hits don't all hammer the DO). User never waits for the cold boot.
 *   - age > 1800s — CF evicts the entry; next request pays the MISS cost.
 */

import { Hono } from "hono";
import type { Env, AppVariables, AppContext } from "../lib/types";
import { getCorrespondentsBundle } from "../lib/do-client";
import { truncAddr, buildBeatsByAddress, resolveNamesWithTimeout } from "../lib/helpers";
import {
  edgeCacheMatchSWR,
  edgeCachePut,
  triggerSWRRefresh,
} from "../lib/edge-cache";

const correspondentsRouter = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

const FRESH_SECONDS = 300;

async function buildCorrespondentsResponse(c: AppContext): Promise<Response> {
  const bundle = await getCorrespondentsBundle(c.env);
  const rows = bundle.correspondents;
  const beats = bundle.beats;
  const leaderboardEntries = bundle.leaderboard;

  // Build address → leaderboard score / earnings maps
  const scoreMap = new Map<string, number>();
  const earningsMap = new Map<string, number>();
  const unpaidMap = new Map<string, number>();
  for (const entry of leaderboardEntries) {
    scoreMap.set(entry.btc_address, Number(entry.score));
    earningsMap.set(entry.btc_address, Number(entry.total_earned_sats));
    unpaidMap.set(entry.btc_address, Number(entry.unpaid_sats ?? 0));
  }

  const beatsByAddress = buildBeatsByAddress(beats, bundle.claims);
  const addresses = rows.map((r) => r.btc_address);
  const nameMap = await resolveNamesWithTimeout(
    c.env.NEWS_KV,
    addresses,
    (p) => c.executionCtx.waitUntil(p)
  );

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
      earnings: {
        total: earningsMap.get(row.btc_address) ?? 0,
        unpaidSats: unpaidMap.get(row.btc_address) ?? 0,
        recentPayments: [] as unknown[],
      },
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

  const body = JSON.stringify({ correspondents, total: correspondents.length });
  const response = new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "public, max-age=60, s-maxage=1800",
    },
  });
  edgeCachePut(c, response);
  return response;
}

// GET /api/correspondents — ranked correspondents with signal counts, streaks, and names.
correspondentsRouter.get("/api/correspondents", async (c) => {
  const hit = await edgeCacheMatchSWR(c, { freshSeconds: FRESH_SECONDS });
  if (hit && !hit.stale) return hit.response;
  if (hit && hit.stale) {
    triggerSWRRefresh(c, "correspondents", () => buildCorrespondentsResponse(c));
    return hit.response;
  }
  return buildCorrespondentsResponse(c);
});

export { correspondentsRouter };
