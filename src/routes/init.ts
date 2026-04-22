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


const initRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/init — all initial page load data in one response.
//
// Wrapped in the Workers edge cache so subsequent visits (anywhere globally)
// get served from the nearest Cloudflare PoP in <100ms instead of paying
// the ~3s DO round-trip + heavy SQL pass we observed in production. Workers
// responses bypass the edge cache by default — the `Cache-Control` header
// alone isn't enough; you have to put the response into `caches.default`
// explicitly. TTL is governed by the Cache-Control header below; the cache
// key is the canonical request URL.
initRouter.get("/api/init", async (c) => {
  const cache = caches.default;
  const cacheKey = new Request(new URL(c.req.url).toString(), { method: "GET" });

  const cached = await cache.match(cacheKey);
  if (cached) {
    // Edge HIT — serve straight from cache, skipping all DO work below.
    // Add a debug header so we can confirm in DevTools that caching is live.
    const hit = new Response(cached.body, cached);
    hit.headers.set("X-Edge-Cache", "HIT");
    return hit;
  }

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
  // Build a claims-by-beat map for member lists
  const claimsByBeat = new Map<string, Array<{ address: string; claimedAt: string }>>();
  for (const claim of bundle.claims) {
    if (!claimsByBeat.has(claim.beat_slug)) claimsByBeat.set(claim.beat_slug, []);
    claimsByBeat.get(claim.beat_slug)!.push({
      address: claim.btc_address,
      claimedAt: claim.claimed_at,
    });
  }
  const beatsPayload = bundle.beats.map((b) => ({
    slug: b.slug,
    name: b.name,
    description: b.description,
    color: b.color,
    claimedBy: b.created_by,
    claimedAt: b.created_at,
    status: b.status,
    members: claimsByBeat.get(b.slug) ?? [],
  }));

  // --- Classifieds ---
  const classifiedsPayload = {
    classifieds: bundle.classifieds.map(transformClassified),
    total: bundle.classifieds.length,
  };

  // --- Correspondents (with agent name resolution) ---
  const scoreMap = new Map<string, number>();
  const earningsMap = new Map<string, number>();
  const unpaidMap = new Map<string, number>();
  for (const entry of bundle.leaderboard) {
    scoreMap.set(entry.btc_address, Number(entry.score));
    earningsMap.set(entry.btc_address, Number(entry.total_earned_sats));
    unpaidMap.set(entry.btc_address, Number(entry.unpaid_sats ?? 0));
  }

  const beatsByAddress = buildBeatsByAddress(bundle.beats, bundle.claims);
  const addresses = bundle.correspondents.map((r) => r.btc_address);
  const nameMap = await resolveNamesWithTimeout(
    c.env.NEWS_KV,
    addresses,
    (p) => c.executionCtx.waitUntil(p)
  );

  const correspondentsList = bundle.correspondents.map((row) => {
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

  // Sort by score descending, then streak, then address to mirror
  // leaderboard tie-breaking when signal_count order diverges after a reset.
  correspondentsList.sort(
    (a, b) =>
      b.score - a.score ||
      b.streak - a.streak ||
      a.address.localeCompare(b.address),
  );

  const correspondentsPayload = {
    correspondents: correspondentsList,
    total: correspondentsList.length,
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

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  c.header("X-Edge-Cache", "MISS");
  const response = c.json({
    brief: briefPayload,
    beats: beatsPayload,
    classifieds: classifiedsPayload,
    correspondents: correspondentsPayload,
    signals: signalsPayload,
  });

  // Store the response at the edge for s-maxage seconds. waitUntil lets the
  // put complete after we've already returned to the user — the first request
  // still pays the DO round-trip, but every subsequent request within the
  // 5-min s-maxage window gets the HIT path above. Clone is required because
  // Response bodies are single-read streams.
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
});

export { initRouter };
