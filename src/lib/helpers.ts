import type { Beat } from "./types";
import type { AgentInfo } from "../services/agent-resolver";
import { resolveAgentNames } from "../services/agent-resolver";

export const PACIFIC_TZ = "America/Los_Angeles";

/**
 * WHY Pacific time?
 *
 * This news system is operated by a Pacific-based publisher. The editorial day
 * runs midnight-to-midnight PT (America/Los_Angeles), which automatically handles
 * both PST (UTC-8) and PDT (UTC-7) via the IANA timezone database.
 *
 * Key timing anchors:
 *   - Briefs are compiled at ~11 pm PT each night. Signals approved before
 *     that cutoff count toward that day's brief and brief_inclusions score.
 *   - Streak boundaries align with the editorial day: a scout must file at
 *     least one approved signal on each consecutive Pacific calendar day to
 *     maintain their streak. Missing a Pacific day breaks the streak even if
 *     only a few UTC hours passed between their last two signals.
 *   - The 30-day rolling window in SQL uses datetime('now', '-30 days') (UTC).
 *     This is intentionally different from streak/day boundaries — it is a
 *     sliding competition window, not an editorial-day boundary.
 */

/**
 * Returns the current date in YYYY-MM-DD format in Pacific time.
 * Use this for streak and day-boundary calculations, not for UTC timestamps.
 */
export function getPacificDate(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: PACIFIC_TZ });
}

/**
 * Returns yesterday's date in YYYY-MM-DD format in Pacific time.
 * "Yesterday" here is Pacific yesterday — a scout who filed at 11:59 pm PT
 * and files again at 12:01 am PT the next day has a consecutive-day streak.
 * The same two signals in UTC could span a very different day boundary.
 */
export function getPacificYesterday(now = new Date()): string {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return getPacificDate(yesterday);
}

/**
 * Formats an ISO date string to a short Pacific time representation
 * e.g. "Mar 3, 10:30 AM"
 */
export function formatPacificShort(isoStr: string): string {
  return new Date(isoStr).toLocaleString("en-US", {
    timeZone: PACIFIC_TZ,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Generate a unique ID using crypto.randomUUID()
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Returns the date string for the day after the given YYYY-MM-DD string
 */
export function getNextDate(date: string): string {
  const d = new Date(date + "T12:00:00Z"); // noon UTC to avoid DST edge
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Returns the UTC ISO string for midnight Pacific time on the given YYYY-MM-DD date.
 * Uses Intl.DateTimeFormat offset detection to handle PST/PDT automatically.
 */
export function getPacificDayStartUTC(date: string): string {
  // Try noon Pacific to avoid DST edge cases when finding the offset
  // We create a Date at noon UTC and check what Pacific time it shows
  // Then we compute: utcMidnightPacific = midnightUTC + pacificOffsetMs
  // Pacific offset: PST = UTC-8, PDT = UTC-7
  // We detect it by formatting a UTC noon time for the given date
  const noonUTC = new Date(date + "T20:00:00Z"); // 20:00 UTC = noon PST or 1pm PDT
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TZ,
    hour: "numeric",
    hour12: false,
    timeZoneName: "short",
  });
  const parts = formatter.formatToParts(noonUTC);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "PST";
  const offsetHours = tzName === "PDT" ? -7 : -8;
  // Midnight Pacific = midnight UTC minus the negative offset = midnight UTC + |offset|
  const midnightUTCMs = Date.parse(date + "T00:00:00Z") - offsetHours * 3600000;
  return new Date(midnightUTCMs).toISOString();
}

/**
 * Returns the UTC ISO string for the end of a Pacific day (midnight of the next day).
 * Used together with getPacificDayStartUTC() to create a [start, end) range.
 */
export function getPacificDayEndUTC(date: string): string {
  return getPacificDayStartUTC(getNextDate(date));
}

/**
 * Compute the Pacific calendar date (YYYY-MM-DD) for an ISO/UTC timestamp string.
 * Useful for annotating API responses so consumers don't need to convert themselves.
 */
export function toPacificDate(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleDateString("en-CA", { timeZone: PACIFIC_TZ });
}

/**
 * Truncate a BTC address for display: "bc1q1234...5678"
 */
export function truncAddr(addr: string): string {
  if (!addr || addr.length < 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

/**
 * Build a map from BTC address to the beats that address has claimed.
 * Shared by correspondents, leaderboard, and init routes.
 *
 * When `claims` is provided, uses beat_claims data for membership.
 * Falls back to beats.created_by for backward compatibility.
 */
export function buildBeatsByAddress(
  beats: Beat[],
  claims?: Array<{ beat_slug: string; btc_address: string }>
): Map<string, { slug: string; name: string; status?: string }[]> {
  const map = new Map<string, { slug: string; name: string; status?: string }[]>();

  if (claims && claims.length > 0) {
    // Build a beat lookup by slug for name/status
    const beatMap = new Map<string, Beat>();
    for (const b of beats) beatMap.set(b.slug, b);

    for (const claim of claims) {
      const b = beatMap.get(claim.beat_slug);
      if (!b) continue;
      const addr = claim.btc_address;
      if (!map.has(addr)) map.set(addr, []);
      map.get(addr)!.push({
        slug: b.slug,
        name: b.name,
        status: b.status ?? "inactive",
      });
    }
  } else {
    // Fallback: derive from created_by (pre-migration compat)
    for (const b of beats) {
      const addr = b.created_by;
      if (!map.has(addr)) map.set(addr, []);
      map.get(addr)!.push({
        slug: b.slug,
        name: b.name,
        status: b.status ?? "inactive",
      });
    }
  }

  // Deterministic ordering: sort each address's beats by slug
  for (const [, beatsForAddress] of map) {
    beatsForAddress.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  return map;
}

/**
 * Resolve agent display names with a timeout.
 *
 * Races agent name resolution against a deadline so that a slow external API
 * (aibtc.com) never blocks the entire page load. If the timeout fires first,
 * the background resolution continues via waitUntil so KV gets populated for
 * the next request.
 *
 * @returns The resolved name map (may be empty if the timeout won).
 */
export async function resolveNamesWithTimeout(
  kv: KVNamespace,
  addresses: string[],
  waitUntil: (p: Promise<unknown>) => void,
  timeoutMs = 12000
): Promise<Map<string, AgentInfo>> {
  const nameResolution = resolveAgentNames(kv, addresses);
  const timeout = new Promise<Map<string, AgentInfo>>((resolve) =>
    setTimeout(() => resolve(new Map()), timeoutMs)
  );
  const nameMap = await Promise.race([nameResolution, timeout]);
  // Let resolution finish in the background so KV cache gets populated
  waitUntil(nameResolution.catch(() => {}));
  return nameMap;
}

