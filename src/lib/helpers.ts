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
 * The effective current streak for display/scoring.
 *
 * `streaks.current_streak` is written only when a signal is filed
 * (applyStreakBumpForSignal), so an agent who stops filing keeps a frozen
 * streak forever. A streak is only "current" if the last signal was today or
 * yesterday (UTC) — the same boundary the streak-bump logic uses to decide
 * continue-vs-reset. Outside that window the streak is broken and reads as 0.
 * `longestStreak` is unaffected, so the historical achievement is preserved.
 *
 * Mirror of the SQL gate in queryLeaderboard's streaks subquery — keep them
 * in sync. `lastSignalDate` is a UTC YYYY-MM-DD string; lexical >= is
 * chronological for that format.
 */
export function effectiveStreak(
  currentStreak: number,
  lastSignalDate: string | null | undefined,
  now = new Date()
): number {
  if (!lastSignalDate) return 0;
  return lastSignalDate >= getUTCYesterday(now) ? currentStreak : 0;
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
 * Collapse rolling numeric fields to stable placeholders (#849, #852).
 *
 * Template re-files change only their rolling numbers between filings - block
 * height, transaction count, price, fee rate - which produced a different
 * fingerprint every time and walked straight through the dedup gate this
 * fingerprint exists to feed. Normalising them before comparison makes the
 * variants collide, so a template an editor already rejected cannot be
 * re-filed by swapping the block number.
 *
 * Labeled rules run first for precision. The final catch-all collapses any
 * remaining run of 4+ digits, so a rolling field a template author adds later
 * (a confirmation count, a mempool depth) still normalises without needing a
 * new rule. Runs of 1-3 digits are deliberately left intact: PR numbers, BIP
 * numbers and version parts identify genuinely distinct stories and must keep
 * separating them.
 */
function normalizeRollingFields(input: string): string {
  return (
    input
      .replace(/\bblock\s+\d{5,7}\b/gi, "block {N}")
      // Matches the word the templates actually use. The earlier form keyed
      // off a "tx"/"txs" abbreviation that never appears in filing text, so it
      // fired on nothing and the catch-all silently covered for it -- which
      // left any sub-1000 count unnormalised. The word itself disambiguates
      // from PR/BIP numbers, so no digit-count floor is needed here.
      .replace(/\b\d+\s*(?:transactions?|txs?)\b/gi, "{TX_COUNT} transactions")
      .replace(/\$[\d,]*\d(?:\.\d+)?/g, "{PRICE}")
      .replace(/\b\d+(?:\.\d+)?\s*sat\/vB\b/gi, "{FEE_RATE}")
      .replace(/\b\d+(?:\.\d+)?\s*[KMG]vB\b/g, "{VSIZE}")
      .replace(/\b\d+(?:\.\d+)?\s*[KMGEZ]?H\/s\b/gi, "{HASHRATE}")
      // Time part optional: a bare `2026-07-04` is as much a rolling field as
      // a full timestamp, and the catch-all alone would only eat its year,
      // leaving `{NUM}-07-04` vs `{NUM}-07-05` stubbornly distinct.
      .replace(/\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?/g, "{TS}")
      .replace(/[+-]?\d+(?:\.\d+)?%/g, "{PCT}")
      .replace(/\b[\d,]{4,}(?:\.\d+)?\b/g, "{NUM}")
  );
}

/**
 * Deterministic content fingerprint for a signal, used by the filing-side
 * dedup gate (issue #845) to detect a re-file with "no meaningful edit since
 * the reject". Built from the normalized headline, body, and primary source
 * URL - the fields an editor judges. Whitespace is collapsed and case folded
 * so cosmetic-only changes still collide; reordering sources or editing the
 * body enough to change these normalized values produces a new fingerprint.
 *
 * Rolling numeric fields are collapsed first (see normalizeRollingFields), so
 * a template re-filed with a fresh block height still matches the rejected
 * original. That pass runs BEFORE the case fold, because the vsize/hashrate
 * rules key off unit capitalisation (KvB, GH/s).
 *
 * Pass the same (sanitized) values that get persisted so a stored rejected
 * signal and a fresh filing of identical content yield the same string. The
 * result is compared by equality only and is never persisted, so changing
 * this function needs no migration - both sides of every comparison are
 * recomputed from source rows on each filing.
 */
export function signalContentFingerprint(input: {
  headline: string;
  body?: string | null;
  sources?: Array<{ url?: string }> | null;
}): string {
  const norm = (s: string) =>
    normalizeRollingFields(s).trim().toLowerCase().replace(/\s+/g, " ");
  const primaryUrl = input.sources?.[0]?.url ? norm(input.sources[0].url) : "";
  return [norm(input.headline ?? ""), norm(input.body ?? ""), primaryUrl].join("\u0000");
}

/**
 * Derive a deterministic payment identifier for x402 V2 RPC idempotency.
 *
 * Produces a stable `pay_<28-hex-char>` string from any combination of
 * caller-provided inputs. Same inputs across retries → same identifier,
 * so the relay's 5-minute idempotency window deduplicates legitimate
 * re-submissions without confusing them with double-spends.
 *
 * The output satisfies PaymentIdentifierSchema: [a-zA-Z0-9_-]{16,128}.
 * `pay_` (4) + 28 hex chars = 32 chars total.
 *
 * @param parts - Ordered components that uniquely identify this payment
 *   (e.g. beatId, senderAddress, nonce or txHex)
 */
export async function derivePaymentIdentifier(...parts: string[]): Promise<string> {
  const input = parts.join("|");
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashHex = [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pay_${hashHex.slice(0, 28)}`;
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
