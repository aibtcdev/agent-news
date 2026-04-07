/**
 * Leaderboard v2 route — weighted scoring with 30-day rolling window.
 *
 * GET  /api/leaderboard         — ranked correspondents with breakdown
 * POST /api/leaderboard/payout  — Publisher-only: record top-3 weekly prizes
 * POST /api/leaderboard/reset   — Publisher-only: snapshot + clear scoring tables
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getLeaderboard, listBeats, recordWeeklyPayouts, getConfig, verifyLeaderboardScore, listLeaderboardSnapshots, getLeaderboardSnapshot, resetLeaderboard } from "../lib/do-client";
import { verifyAuth } from "../services/auth";
import { CONFIG_PUBLISHER_ADDRESS, WEEKLY_PRIZE_1ST_SATS, WEEKLY_PRIZE_2ND_SATS, WEEKLY_PRIZE_3RD_SATS } from "../lib/constants";
import { validateBtcAddress } from "../lib/validators";
import { truncAddr, buildBeatsByAddress, resolveNamesWithTimeout } from "../lib/helpers";

type AppContext = { Bindings: Env; Variables: AppVariables };

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

/**
 * Verify BIP-322 auth and confirm publisher designation for a given address.
 * Returns the validated address on success, or a Response on failure.
 */
async function verifyPublisher(
  c: { req: { raw: Request }; env: Env; json: (data: unknown, status?: number) => Response },
  btcAddress: string,
  method: string,
  path: string
): Promise<string | Response> {
  if (!btcAddress) {
    return c.json({ error: "Missing required field: btc_address" }, 400);
  }
  if (!validateBtcAddress(btcAddress)) {
    return c.json({ error: "Invalid BTC address format (expected bech32 bc1...)" }, 400);
  }

  const authResult = verifyAuth(c.req.raw.headers, btcAddress, method, path);
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  let publisherConfig: Awaited<ReturnType<typeof getConfig>>;
  try {
    publisherConfig = await getConfig(c.env, CONFIG_PUBLISHER_ADDRESS);
  } catch {
    return c.json({ error: "Unable to verify publisher designation — try again later" }, 503);
  }
  if (!publisherConfig || !publisherConfig.value) {
    return c.json({ error: "No publisher designated — set publisher_btc_address in config first" }, 403);
  }
  const canonicalAddress = publisherConfig.value.trim();
  if (btcAddress.toLowerCase().trim() !== canonicalAddress.toLowerCase()) {
    return c.json({ error: "Only the designated Publisher can access this endpoint" }, 403);
  }

  return canonicalAddress;
}

/** Convenience: read btc_address from query param and verify publisher. */
async function requirePublisher(
  c: { req: { raw: Request; query: (k: string) => string | undefined }; env: Env; json: (data: unknown, status?: number) => Response },
  method: string,
  path: string
): Promise<string | Response> {
  return verifyPublisher(c, c.req.query("btc_address") ?? "", method, path);
}

/** Parse btc_address from JSON body and verify publisher. */
async function requirePublisherFromBody(
  c: { req: { raw: Request; json: <T>() => Promise<T> }; env: Env; json: (data: unknown, status?: number) => Response },
  method: string,
  path: string
): Promise<{ address: string; body: Record<string, unknown> } | Response> {
  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    // Fall through to validation below
  }

  const result = await verifyPublisher(c, (body.btc_address as string) ?? "", method, path);
  if (result instanceof Response) return result;

  return { address: result, body };
}

const leaderboardRouter = new Hono<AppContext>();

// GET /api/leaderboard — weighted leaderboard with scoring breakdown
leaderboardRouter.get("/api/leaderboard", async (c) => {
  const [entries, beats] = await Promise.all([
    getLeaderboard(c.env),
    listBeats(c.env),
  ]);

  // Extract claims from beat members for buildBeatsByAddress
  const claims: Array<{ beat_slug: string; btc_address: string }> = [];
  for (const b of beats) {
    for (const m of b.members ?? []) {
      claims.push({ beat_slug: b.slug, btc_address: m.btc_address });
    }
  }
  const beatsByAddress = buildBeatsByAddress(beats, claims);
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
        totalEarnedSats: Number(entry.total_earned_sats),
        unpaidSats: Number(entry.unpaid_sats ?? 0),
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
  const pubResult = await requirePublisherFromBody(c, "POST", "/api/leaderboard/payout");
  if (pubResult instanceof Response) return pubResult;

  const { week } = pubResult.body;

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

// GET /api/leaderboard/breakdown — Publisher-only: full component breakdown for all scouts
// Returns the same data as /api/leaderboard but without name resolution or caching.
leaderboardRouter.get("/api/leaderboard/breakdown", async (c) => {
  const result = await requirePublisher(c, "GET", "/api/leaderboard/breakdown");
  if (result instanceof Response) return result;

  const entries = await getLeaderboard(c.env);
  return c.json({ ok: true, entries, total: entries.length });
});

// GET /api/leaderboard/verify/:address — public: recalculate a single scout's score from raw tables
leaderboardRouter.get("/api/leaderboard/verify/:address", async (c) => {
  const address = c.req.param("address");

  if (!validateBtcAddress(address)) {
    return c.json({ error: "Invalid BTC address format (expected bech32 bc1...)" }, 400);
  }

  const result = await verifyLeaderboardScore(c.env, address);
  if (!result.ok) {
    const status = result.status === 404 ? 404 : 500;
    return c.json({ error: result.error ?? "Failed to verify score" }, status);
  }

  return c.json(result.data);
});

// GET /api/leaderboard/snapshots — Publisher-only: list stored snapshots (metadata only)
leaderboardRouter.get("/api/leaderboard/snapshots", async (c) => {
  const result = await requirePublisher(c, "GET", "/api/leaderboard/snapshots");
  if (result instanceof Response) return result;

  const snapshots = await listLeaderboardSnapshots(c.env, result);
  return c.json({ ok: true, snapshots, total: snapshots.length });
});

// GET /api/leaderboard/snapshots/:id — Publisher-only: retrieve a specific snapshot with full data
leaderboardRouter.get("/api/leaderboard/snapshots/:id", async (c) => {
  const id = c.req.param("id");
  const pubResult = await requirePublisher(c, "GET", `/api/leaderboard/snapshots/${id}`);
  if (pubResult instanceof Response) return pubResult;

  const result = await getLeaderboardSnapshot(c.env, id, pubResult);
  if (!result.ok) {
    const status = result.status === 404 ? 404 : 500;
    return c.json({ error: result.error ?? "Failed to retrieve snapshot" }, status);
  }

  return c.json(result.data);
});

// POST /api/leaderboard/reset — Publisher-only: snapshot leaderboard, clear 5 scoring tables, prune old snapshots
// Body: { btc_address: string }
// Signals are preserved. Snapshots are pruned to keep only the 10 most recent.
leaderboardRouter.post("/api/leaderboard/reset", async (c) => {
  const pubResult = await requirePublisherFromBody(c, "POST", "/api/leaderboard/reset");
  if (pubResult instanceof Response) return pubResult;

  const result = await resetLeaderboard(c.env, pubResult.address);
  if (!result.ok) {
    const status = typeof result.status === "number" ? result.status : 500;
    return c.json({ error: result.error ?? "Failed to reset leaderboard" }, status);
  }

  return c.json({ ok: true, ...result.data }, 200);
});

export { leaderboardRouter };
