/**
 * Init route — single endpoint that returns all data needed for the initial page load.
 *
 * Replaces 5 parallel API calls (brief, beats, classifieds, correspondents, front-page)
 * with a single request that makes one DO round-trip, eliminating serialization overhead
 * from multiple requests hitting the same singleton DO.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getInitBundle } from "../lib/do-client";
import { transformClassified } from "./classifieds";
import { getUTCDate, truncAddr, buildBeatsByAddress, resolveNamesWithTimeout } from "../lib/helpers";
import { BRIEF_PRICE_SATS } from "../lib/constants";
import { edgeCacheMatch, edgeCachePut } from "../lib/edge-cache";


const initRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/init — all initial page load data in one response.
// Edge-cached via the Workers Cache API (see src/lib/edge-cache.ts) so
// subsequent visits within the s-maxage window serve from the nearest
// Cloudflare PoP in <100ms instead of paying the ~3s DO round-trip.
initRouter.get("/api/init", async (c) => {
  const cached = await edgeCacheMatch(c);
  if (cached) return cached;

  const bundle = await getInitBundle(c.env);
  const today = getUTCDate();

  // --- Brief ---
  const todaysBrief = bundle.brief?.date === today ? bundle.brief : null;
  let briefPayload: Record<string, unknown>;
  if (todaysBrief) {
    let jsonData: Record<string, unknown> = {};
    if (todaysBrief.json_data) {
      try {
        jsonData = JSON.parse(todaysBrief.json_data) as Record<string, unknown>;
      } catch (err) {
        console.error("Failed to parse brief json_data in /api/init:", err);
      }
    }
    const inscription = todaysBrief.inscription_id
      ? { inscriptionId: todaysBrief.inscription_id, inscribedTxid: todaysBrief.inscribed_txid }
      : (jsonData.inscription ?? null);
    briefPayload = {
      preview: false,
      date: todaysBrief.date,
      compiledAt: todaysBrief.compiled_at,
      latest: true,
      archive: bundle.briefDates,
      inscription,
      price: { amount: BRIEF_PRICE_SATS, asset: "sBTC (sats)", protocol: "x402" },
      ...jsonData,
      text: todaysBrief.text,
    };
  } else {
    briefPayload = {
      date: today,
      compiledAt: null,
      latest: true,
      archive: bundle.briefDates,
      inscription: null,
    };
  }

  // --- Beats ---
  // Count claims per beat so we can surface `memberCount` without shipping
  // the entire member roster on the homepage — that array was the largest
  // field in the /api/init payload and the homepage never reads it.
  // Consumers that need the full list (e.g. the Bureau page) hit
  // /api/beats?include=members directly.
  const memberCountByBeat = new Map<string, number>();
  for (const claim of bundle.claims) {
    memberCountByBeat.set(
      claim.beat_slug,
      (memberCountByBeat.get(claim.beat_slug) ?? 0) + 1
    );
  }
  const beatsPayload = bundle.beats.map((b) => {
    // null (not 0) when there's no entry in the map — "unknown" is a
    // different state from "known zero" and we'd rather surface a data
    // integrity issue than silently misreport.
    const count = memberCountByBeat.get(b.slug);
    return {
      slug: b.slug,
      name: b.name,
      description: b.description,
      color: b.color,
      claimedBy: b.created_by,
      claimedAt: b.created_at,
      status: b.status,
      dailyApprovedLimit: b.daily_approved_limit ?? null,
      editorReviewRateSats: b.editor_review_rate_sats ?? null,
      // Editor lands here from the DO's /init handler — matches the shape
      // returned by /api/beats so the homepage no longer needs a second
      // round-trip (overrideBeatsWithCanonical) to pick up editor info.
      editor: b.editor
        ? { address: b.editor.btc_address, assignedAt: b.editor.registered_at }
        : null,
      memberCount: count ?? null,
    };
  });

  // --- Classifieds ---
  const classifiedsPayload = {
    classifieds: bundle.classifieds.map(transformClassified),
    total: bundle.classifieds.length,
  };

  // --- Correspondents (with agent name resolution) ---
  // The homepage renders only the top-5 correspondents by score (TOP_N in
  // public/index.html). Shipping all ~400+ entries in /api/init made the
  // payload ~400KB uncompressed — the single largest network cost on
  // initial load. We cap to TOP_CORRESPONDENTS here and keep the real
  // `total` so UI stats stay accurate. Full list remains at
  // /api/correspondents for the dedicated page.
  //
  // We sort BEFORE name resolution so `resolveAgentNames` only does
  // lookups for the capped slice instead of every correspondent — this
  // also slashes the KV/API work on /api/init cache misses.
  const TOP_CORRESPONDENTS = 20;

  const scoreMap = new Map<string, number>();
  const earningsMap = new Map<string, number>();
  const unpaidMap = new Map<string, number>();
  for (const entry of bundle.leaderboard) {
    scoreMap.set(entry.btc_address, Number(entry.score));
    earningsMap.set(entry.btc_address, Number(entry.total_earned_sats));
    unpaidMap.set(entry.btc_address, Number(entry.unpaid_sats ?? 0));
  }

  const beatsByAddress = buildBeatsByAddress(bundle.beats, bundle.claims);

  // Sort by score desc, then streak desc, then address to mirror the
  // leaderboard's tie-breaking. Matches the original post-map sort.
  const sortedCorrespondents = [...bundle.correspondents].sort((a, b) => {
    const aScore = scoreMap.get(a.btc_address) ?? 0;
    const bScore = scoreMap.get(b.btc_address) ?? 0;
    if (bScore !== aScore) return bScore - aScore;
    const aStreak = Number(a.current_streak) || 0;
    const bStreak = Number(b.current_streak) || 0;
    if (bStreak !== aStreak) return bStreak - aStreak;
    return a.btc_address.localeCompare(b.btc_address);
  });
  const topCorrespondents = sortedCorrespondents.slice(0, TOP_CORRESPONDENTS);

  const topAddresses = topCorrespondents.map((r) => r.btc_address);
  const nameMap = await resolveNamesWithTimeout(
    c.env.NEWS_KV,
    topAddresses,
    (p) => c.executionCtx.waitUntil(p)
  );

  const correspondentsList = topCorrespondents.map((row) => {
    const signalCount = Number(row.signal_count) || 0;
    const streak = Number(row.current_streak) || 0;
    const longestStreak = Number(row.longest_streak) || 0;
    const daysActive = Number(row.days_active) || 0;
    const score = scoreMap.get(row.btc_address) ?? 0;
    const info = nameMap.get(row.btc_address);
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
      earnings: { total: earningsMap.get(row.btc_address) ?? 0, unpaidSats: unpaidMap.get(row.btc_address) ?? 0, recentPayments: [] as unknown[] },
      display_name: info?.name ?? null,
      avatar: `https://bitcoinfaces.xyz/api/get-image?name=${encodeURIComponent(avatarAddr)}`,
      registered: info?.name !== null && info?.name !== undefined,
    };
  });

  const correspondentsPayload = {
    correspondents: correspondentsList,
    // Total is the REAL count of correspondents (not the trimmed slice),
    // so `stat-correspondents` displays properly on the homepage.
    total: sortedCorrespondents.length,
  };

  // --- Signals ---
  const signalsPayload = {
    signals: bundle.signals.map((s) => ({
      id: s.id,
      btcAddress: s.btc_address,
      beat: s.beat_name ?? s.beat_slug,
      beatSlug: s.beat_slug,
      headline: s.headline,
      content: s.body,
      sources: s.sources,
      tags: s.tags,
      timestamp: s.created_at,
      status: s.status,
      disclosure: s.disclosure,
      correction_of: s.correction_of,
    })),
    total: bundle.signals.length,
    curated: true,
  };

  // s-maxage=1800 (30 min) — beat counts + signal-per-hour ticker are
  // glance info; a few minutes of staleness is invisible to users, and
  // the longer edge TTL reduces the cold-miss rate that caused visible
  // ~2-3s pauses every 5 minutes. The homepage surfaces a "Counts: Xm ago"
  // label derived from `generatedAt` so staleness is honest.
  c.header("Cache-Control", "public, max-age=60, s-maxage=1800");
  const response = c.json({
    brief: briefPayload,
    beats: beatsPayload,
    classifieds: classifiedsPayload,
    correspondents: correspondentsPayload,
    signals: signalsPayload,
    // Pass-through from the DO: saves the homepage from firing
    // 3 × /api/signals/counts?beat=X + the ticker's /api/signals/counts?since=1h.
    beatStats: bundle.beatStats ?? {},
    signalsCount1h: bundle.signalsCount1h ?? 0,
    // Frozen at the moment this response was actually generated. The
    // cache can serve this copy for up to s-maxage; the client renders
    // "Counts: Xm ago" so users see when the numbers were computed,
    // regardless of how old the cached body is.
    generatedAt: new Date().toISOString(),
  });
  edgeCachePut(c, response);
  return response;
});

export { initRouter };
