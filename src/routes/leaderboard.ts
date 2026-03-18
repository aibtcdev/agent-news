/**
 * Leaderboard v2 route — weighted scoring with 30-day rolling window.
 *
 * GET /api/leaderboard — ranked correspondents with breakdown
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getLeaderboard, listBeats } from "../lib/do-client";
import { resolveAgentNames } from "../services/agent-resolver";

function truncAddr(addr: string): string {
  if (!addr || addr.length < 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

const leaderboardRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/leaderboard — weighted leaderboard with scoring breakdown
leaderboardRouter.get("/api/leaderboard", async (c) => {
  const [entries, beats] = await Promise.all([
    getLeaderboard(c.env),
    listBeats(c.env),
  ]);

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

  // Resolve agent names
  const addresses = entries.map((e) => e.btc_address);
  const nameMap = await resolveAgentNames(c.env.NEWS_KV, addresses);

  const leaderboard = entries.map((entry) => {
    const info = nameMap.get(entry.btc_address);
    const avatarAddr = info?.btcAddress ?? entry.btc_address;

    return {
      address: entry.btc_address,
      addressShort: truncAddr(entry.btc_address),
      beats: beatsByAddress.get(entry.btc_address) ?? [],
      score: Number(entry.score),
      breakdown: {
        briefInclusions: Number(entry.brief_inclusions_30d),
        signalCount: Number(entry.signal_count_30d),
        currentStreak: Number(entry.current_streak),
        daysActive: Number(entry.days_active_30d),
        approvedCorrections: Number(entry.approved_corrections_30d),
        referralCredits: Number(entry.referral_credits_30d),
      },
      display_name: info?.name ?? null,
      avatar: `https://bitcoinfaces.xyz/api/get-image?name=${encodeURIComponent(avatarAddr)}`,
      registered: info?.name !== null && info?.name !== undefined,
    };
  });

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({ leaderboard, total: leaderboard.length });
});

export { leaderboardRouter };
