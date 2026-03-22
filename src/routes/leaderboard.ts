/**
 * Leaderboard v2 route — weighted scoring with 30-day rolling window.
 *
 * GET  /api/leaderboard         — ranked correspondents with breakdown
 * POST /api/leaderboard/payout  — Publisher-only: record top-3 weekly prizes
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getLeaderboard, listBeats, recordWeeklyPayouts, getConfig } from "../lib/do-client";
import { verifyAuth } from "../services/auth";
import { CONFIG_PUBLISHER_ADDRESS, WEEKLY_PRIZE_1ST_SATS, WEEKLY_PRIZE_2ND_SATS, WEEKLY_PRIZE_3RD_SATS } from "../lib/constants";
import { validateBtcAddress } from "../lib/validators";
import { truncAddr, buildBeatsByAddress, resolveNamesWithTimeout } from "../lib/helpers";

/**
 * Compute the ISO 8601 week string for the previous week relative to `date`.
 * Returns a string in the format "YYYY-WNN" (zero-padded week number).
 *
 * ISO week: week starts on Monday; week 1 is the week containing the first Thursday of the year.
 */
function getPreviousISOWeek(date: Date): string {
  // Step back 7 days to land in the previous week
  const prev = new Date(date);
  prev.setUTCDate(prev.getUTCDate() - 7);

  // Compute ISO week number for that date
  // Algorithm: find Thursday of that week's ISO week, then derive year and week
  const d = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), prev.getUTCDate()));
  // ISO week day: Mon=1 … Sun=7
  const dayOfWeek = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  // Move to Thursday of the same ISO week
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const year = d.getUTCFullYear();
  // Jan 1 of that year
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, "0")}`;
}

const leaderboardRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/leaderboard — weighted leaderboard with scoring breakdown
leaderboardRouter.get("/api/leaderboard", async (c) => {
  const [entries, beats] = await Promise.all([
    getLeaderboard(c.env),
    listBeats(c.env),
  ]);

  const beatsByAddress = buildBeatsByAddress(beats);
  const addresses = entries.map((e) => e.btc_address);
  const nameMap = await resolveNamesWithTimeout(
    c.env.NEWS_KV,
    addresses,
    (p) => c.executionCtx.waitUntil(p)
  );

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

// POST /api/leaderboard/payout — Publisher-only: record top-3 weekly prize earnings
// Body: { btc_address: string, week?: string }
// week defaults to the previous ISO week if omitted.
// Prize amounts (defined in constants.ts): 1st=$WEEKLY_PRIZE_1ST_SATS, 2nd=..., 3rd=...
leaderboardRouter.post("/api/leaderboard/payout", async (c) => {
  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    // Body is required for auth — fall through to validation below
  }

  const { btc_address, week } = body;

  if (!btc_address) {
    return c.json({ error: "Missing required field: btc_address" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json({ error: "Invalid BTC address format (expected bech32 bc1...)" }, 400);
  }

  // BIP-322 auth
  const authResult = verifyAuth(
    c.req.raw.headers,
    btc_address as string,
    "POST",
    "/api/leaderboard/payout"
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  // Publisher gate — fail closed if config lookup errors
  let publisherConfig: Awaited<ReturnType<typeof getConfig>>;
  try {
    publisherConfig = await getConfig(c.env, CONFIG_PUBLISHER_ADDRESS);
  } catch {
    return c.json({ error: "Unable to verify publisher designation — try again later" }, 503);
  }
  if (!publisherConfig || !publisherConfig.value) {
    return c.json({ error: "No publisher designated — set publisher_btc_address in config first" }, 403);
  }
  if ((btc_address as string).toLowerCase().trim() !== publisherConfig.value.toLowerCase().trim()) {
    return c.json({ error: "Only the designated Publisher can issue weekly payouts" }, 403);
  }

  // Resolve week — default to previous ISO week
  let targetWeek: string;
  if (week && typeof week === "string") {
    if (!/^\d{4}-W\d{2}$/.test(week)) {
      return c.json({ error: "Invalid week format — use YYYY-WNN (e.g. '2026-W11')" }, 400);
    }
    const weekNum = parseInt(week.slice(-2), 10);
    if (weekNum < 1 || weekNum > 53) {
      return c.json({ error: "Invalid ISO week number — must be between 01 and 53" }, 400);
    }
    targetWeek = week;
  } else {
    targetWeek = getPreviousISOWeek(new Date());
  }

  // Record earnings in the DO (double-pay prevention via UNIQUE index)
  const payoutResult = await recordWeeklyPayouts(c.env, targetWeek);
  if (!payoutResult.ok) {
    return c.json({ error: payoutResult.error ?? "Failed to record weekly payouts" }, 500);
  }

  const data = payoutResult.data!;

  // Build informational prize map for the response
  const prizeAmounts: Record<string, number> = {
    weekly_prize_1st: WEEKLY_PRIZE_1ST_SATS,
    weekly_prize_2nd: WEEKLY_PRIZE_2ND_SATS,
    weekly_prize_3rd: WEEKLY_PRIZE_3RD_SATS,
  };

  return c.json(
    {
      ok: true,
      week: data.week,
      paid: data.paid,
      skipped: data.skipped,
      warnings: data.warnings,
      prize_amounts_sats: prizeAmounts,
    },
    201
  );
});

export { leaderboardRouter };
