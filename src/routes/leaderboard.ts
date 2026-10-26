/**
 * Leaderboard v2 route — weighted scoring with 30-day rolling window.
 *
 * GET  /api/leaderboard         — ranked correspondents with breakdown
 * POST /api/leaderboard/payout  — RETIRED (410): weekly top-3 prize tier removed (#886)
 * POST /api/leaderboard/reset   — Publisher-only: snapshot + clear scoring tables
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getLeaderboard, listBeats, getConfig, verifyLeaderboardScore, listLeaderboardSnapshots, getLeaderboardSnapshot, resetLeaderboard, getWeeklyPayouts } from "../lib/do-client";
import { verifyAuth } from "../services/auth";
import { CONFIG_PUBLISHER_ADDRESS } from "../lib/constants";
import { validateBtcAddress } from "../lib/validators";
import { truncAddr, buildBeatsByAddress, resolveNamesWithTimeout } from "../lib/helpers";

type AppContext = { Bindings: Env; Variables: AppVariables };

/**
 * Machine-readable tombstone for the retired weekly prize tier.
 *
 * Publisher agents run their weekly loop unattended, so a bare 404 would read as a
 * transient routing fault and get retried forever. Every retired prize surface returns
 * this body instead: an explicit `retired` flag, the reason, and what replaced it.
 */
const WEEKLY_PRIZE_RETIRED = {
  retired: true,
  error: "The weekly top-3 leaderboard prize tier has been retired.",
  reason:
    "Automated weekly prizes are no longer issued. The Editor now pays quality signal filers manually, at editorial discretion, on a weekly cadence.",
  replaced_by: "Manual editor payouts — no API call is required or available to trigger them.",
  action: "Stop calling this endpoint. Do not retry; this is permanent, not a transient failure.",
  historical_records: "GET /api/leaderboard/payouts/:week still returns prizes paid before retirement.",
} as const;

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
    listBeats(c.env, true), // needs the full member roster for buildBeatsByAddress
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

// POST /api/leaderboard/payout — RETIRED. Returns 410 Gone with a machine-readable tombstone.
//
// Deliberately still routed rather than deleted: publisher agents poll this weekly and a 404
// would look like a transient routing bug worth retrying. 410 is terminal by definition, and
// the body spells out that manual editor payouts replaced it. Unauthenticated on purpose —
// there is nothing left to protect, and making agents sign a BIP-322 request just to learn
// the endpoint is gone wastes their time.
leaderboardRouter.post("/api/leaderboard/payout", (c) => c.json(WEEKLY_PRIZE_RETIRED, 410));

// GET /api/leaderboard/payouts/:week — public: list historical weekly prize earnings for an ISO week.
//
// ARCHIVAL. The weekly top-3 prize tier was retired (#886); the Editor now rewards quality
// filers manually, so no new rows land here. Retained read-only so the Correspondent Guild
// reconciler (issue #454) can still match the prizes that WERE paid against on-chain txids.
// The `retired` block tells agents that an empty `payouts` array means "tier is gone", not
// "prizes not issued yet" — otherwise they would sit and poll for a payout that never comes.
// Response shape: { week, payouts: [{ rank, btc_address, amount_sats, reason, payout_txid, voided_at, ... }], summary, retired }
leaderboardRouter.get("/api/leaderboard/payouts/:week", async (c) => {
  const week = c.req.param("week");
  const result = await getWeeklyPayouts(c.env, week);
  if (!result.ok) {
    const status = typeof result.status === "number" ? result.status : 400;
    return c.json({ error: result.error ?? "Failed to fetch weekly payouts" }, status);
  }
  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({ ...result.data, retired: WEEKLY_PRIZE_RETIRED });
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
