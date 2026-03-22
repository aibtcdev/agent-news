import type { Beat } from "./types";
import type { AgentInfo } from "../services/agent-resolver";
import { resolveAgentNames } from "../services/agent-resolver";

export const PACIFIC_TZ = "America/Los_Angeles";

/**
 * Returns the current date in YYYY-MM-DD format in Pacific time
 */
export function getPacificDate(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: PACIFIC_TZ });
}

/**
 * Returns yesterday's date in YYYY-MM-DD format in Pacific time
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
 * Truncate a BTC address for display: "bc1q1234...5678"
 */
export function truncAddr(addr: string): string {
  if (!addr || addr.length < 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

/**
 * Build a map from BTC address to the beats that address has claimed.
 * Shared by correspondents, leaderboard, and init routes.
 */
export function buildBeatsByAddress(
  beats: Beat[]
): Map<string, { slug: string; name: string; status?: string }[]> {
  const map = new Map<string, { slug: string; name: string; status?: string }[]>();
  for (const b of beats) {
    const addr = b.created_by;
    if (!map.has(addr)) map.set(addr, []);
    map.get(addr)!.push({
      slug: b.slug,
      name: b.name,
      status: b.status ?? "inactive",
    });
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
  timeoutMs = 3000
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

