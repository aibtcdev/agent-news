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
import { resolveAgentNames } from "../services/agent-resolver";
import { transformClassified } from "./classifieds";
import { getPacificDate } from "../lib/helpers";
import { BRIEF_PRICE_SATS } from "../lib/constants";

function truncAddr(addr: string): string {
  if (!addr || addr.length < 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

const initRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/init — all initial page load data in one response
initRouter.get("/api/init", async (c) => {
  const bundle = await getInitBundle(c.env);
  const today = getPacificDate();

  // --- Brief ---
  const todaysBrief = bundle.brief?.date === today ? bundle.brief : null;
  let briefPayload: Record<string, unknown>;
  if (todaysBrief) {
    const jsonData = todaysBrief.json_data
      ? (JSON.parse(todaysBrief.json_data) as Record<string, unknown>)
      : {};
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
  const beatsPayload = bundle.beats.map((b) => ({
    slug: b.slug,
    name: b.name,
    description: b.description,
    color: b.color,
    claimedBy: b.created_by,
    claimedAt: b.created_at,
    status: b.status,
  }));

  // --- Classifieds ---
  const classifiedsPayload = {
    classifieds: bundle.classifieds.map(transformClassified),
    total: bundle.classifieds.length,
  };

  // --- Correspondents (with agent name resolution) ---
  const scoreMap = new Map<string, number>();
  for (const entry of bundle.leaderboard) {
    scoreMap.set(entry.btc_address, Number(entry.score));
  }

  const beatsByAddress = new Map<string, { slug: string; name: string; status?: string }[]>();
  for (const b of bundle.beats) {
    const addr = b.created_by;
    if (!beatsByAddress.has(addr)) beatsByAddress.set(addr, []);
    beatsByAddress.get(addr)?.push({
      slug: b.slug,
      name: b.name,
      status: b.status ?? "inactive",
    });
  }

  const addresses = bundle.correspondents.map((r) => r.btc_address);
  // Race agent name resolution against a 3-second timeout.
  // If aibtc.com is slow or KV cache is cold, we return without names rather than
  // blocking the entire page load. The frontend gracefully falls back to truncated addresses.
  // Fire-and-forget: continue resolution in the background so KV gets populated for next request.
  const nameResolution = resolveAgentNames(c.env.NEWS_KV, addresses);
  const timeout = new Promise<Map<string, import("../services/agent-resolver").AgentInfo>>(
    (resolve) => setTimeout(() => resolve(new Map()), 3000)
  );
  const nameMap = await Promise.race([nameResolution, timeout]);
  // If we timed out, let the resolution continue in the background to populate KV cache
  c.executionCtx.waitUntil(nameResolution.catch(() => {}));

  const correspondentsPayload = {
    correspondents: bundle.correspondents.map((row) => {
      const signalCount = Number(row.signal_count) || 0;
      const streak = Number(row.current_streak) || 0;
      const longestStreak = Number(row.longest_streak) || 0;
      const daysActive = Number((row as unknown as Record<string, unknown>).days_active) || 0;
      const score = scoreMap.get(row.btc_address) ?? (signalCount * 10 + streak * 5 + daysActive * 2);
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
        earnings: { total: 0, recentPayments: [] as unknown[] },
        display_name: info?.name ?? null,
        avatar: `https://bitcoinfaces.xyz/api/get-image?name=${encodeURIComponent(avatarAddr)}`,
        registered: info?.name !== null && info?.name !== undefined,
      };
    }),
    total: bundle.correspondents.length,
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
  return c.json({
    brief: briefPayload,
    beats: beatsPayload,
    classifieds: classifiedsPayload,
    correspondents: correspondentsPayload,
    signals: signalsPayload,
  });
});

export { initRouter };
