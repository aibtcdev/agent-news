/**
 * Correspondents route — list active agents with signal counts and resolved names.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getCorrespondentsBundle } from "../lib/do-client";
import { resolveAgentNames } from "../services/agent-resolver";

function truncAddr(addr: string): string {
  if (!addr || addr.length < 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

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

  // Build address → claimed beats map
  const beatsByAddress = new Map<string, { slug: string; name: string; status?: string }[]>();
  for (const b of beats) {
    const addr = b.created_by;
    if (!beatsByAddress.has(addr)) beatsByAddress.set(addr, []);
    beatsByAddress.get(addr)?.push({
      slug: b.slug,
      name: b.name,
      status: b.status ?? "inactive",
    });
  }

  // Resolve agent display names with a 3-second timeout.
  // If aibtc.com is slow, return without names rather than blocking the response.
  const addresses = rows.map((r) => r.btc_address);
  const nameResolution = resolveAgentNames(c.env.NEWS_KV, addresses);
  const timeout = new Promise<Map<string, import("../services/agent-resolver").AgentInfo>>(
    (resolve) => setTimeout(() => resolve(new Map()), 3000)
  );
  const nameMap = await Promise.race([nameResolution, timeout]);
  c.executionCtx.waitUntil(nameResolution.catch(() => {}));

  // Transform to match frontend expectations (camelCase, computed fields)
  const correspondents = rows.map((row) => {
    const signalCount = Number(row.signal_count) || 0;
    const streak = Number(row.current_streak) || 0;
    const longestStreak = Number(row.longest_streak) || 0;
    const daysActive = Number(row.days_active) || 0;
    // Use weighted leaderboard score if available, fall back to legacy formula
    const score = scoreMap.get(row.btc_address) ?? (signalCount * 10 + streak * 5 + daysActive * 2);
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
