import type { Beat } from "./types";
import type { AgentInfo } from "../services/agent-resolver";
import { resolveAgentNames } from "../services/agent-resolver";

/**
 * Returns the current date in YYYY-MM-DD format in UTC.
 * Use this for streak and day-boundary calculations.
 */
export function getUTCDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Returns yesterday's date in YYYY-MM-DD format in UTC.
 */
export function getUTCYesterday(now = new Date()): string {
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return getUTCDate(yesterday);
}

/**
 * Formats an ISO date string to a short UTC time representation
 * e.g. "Mar 3, 10:30 AM UTC"
 */
export function formatUTCShort(isoStr: string): string {
  return (
    new Date(isoStr).toLocaleString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }) + " UTC"
  );
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
  const d = new Date(date + "T12:00:00Z"); // noon UTC to avoid date rollover at midnight
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Returns the UTC ISO string for midnight UTC on the given YYYY-MM-DD date.
 */
export function getUTCDayStart(date: string): string {
  return date + "T00:00:00.000Z";
}

/**
 * Returns the UTC ISO string for the end of a UTC day (midnight of the next day).
 * Used together with getUTCDayStart() to create a [start, end) range.
 */
export function getUTCDayEnd(date: string): string {
  return getNextDate(date) + "T00:00:00.000Z";
}

/**
 * Compute the UTC calendar date (YYYY-MM-DD) for an ISO/UTC timestamp string.
 * Useful for annotating API responses so consumers don't need to convert themselves.
 */
export function toUTCDate(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
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
