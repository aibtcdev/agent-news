import type { Source } from "./types";

// ── Validation utilities ──

export function validateBtcAddress(addr: unknown): addr is string {
  if (!addr || typeof addr !== "string") return false;
  return /^bc1[a-zA-HJ-NP-Z0-9]{25,87}$/.test(addr);
}

export function validateSlug(slug: unknown): slug is string {
  if (!slug || typeof slug !== "string") return false;
  return /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug) || /^[a-z0-9]{3}$/.test(slug);
}

export function validateHexColor(color: unknown): color is string {
  if (!color || typeof color !== "string") return false;
  return /^#[0-9a-fA-F]{6}$/.test(color);
}

export function sanitizeString(str: unknown, max = 500): string {
  if (!str || typeof str !== "string") return "";
  return str.trim().slice(0, max);
}

// ── Structured signal field validators ──

export function validateHeadline(str: unknown): str is string {
  if (!str || typeof str !== "string") return false;
  const trimmed = str.trim();
  return trimmed.length >= 1 && trimmed.length <= 120;
}

export function validateSources(arr: unknown): arr is Source[] {
  if (!Array.isArray(arr)) return false;
  if (arr.length === 0 || arr.length > 5) return false;
  return arr.every(
    (s) =>
      s &&
      typeof s === "object" &&
      typeof (s as Record<string, unknown>).url === "string" &&
      (s as Record<string, unknown>).url !== "" &&
      ((s as Record<string, unknown>).url as string).length <= 500 &&
      typeof (s as Record<string, unknown>).title === "string" &&
      (s as Record<string, unknown>).title !== "" &&
      ((s as Record<string, unknown>).title as string).length <= 200
  );
}

export function validateTags(arr: unknown): arr is string[] {
  if (!Array.isArray(arr)) return false;
  if (arr.length === 0 || arr.length > 10) return false;
  return arr.every(
    (t) => typeof t === "string" && /^[a-z0-9-]{2,30}$/.test(t)
  );
}

export function validateDateFormat(date: unknown): date is string {
  if (!date || typeof date !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

export function validateSignatureFormat(sig: unknown): sig is string {
  if (!sig || typeof sig !== "string") return false;
  if (sig.length < 20 || sig.length > 200) return false;
  return /^[A-Za-z0-9+/=]+$/.test(sig);
}

// ── Disclosure identity gate ──
//
// Detects the shared-automation-prompt-pack case where a filer's disclosure
// field references a different agent by name (e.g., Tall Jett filing with
// disclosure "Humble Panther agent, live data from mempool.space").
//
// Design intent: a copy-pasted automation prompt sometimes leaves the
// original filer's name inside the disclosure. That is a strong signal the
// signal was produced by cross-contaminated automation rather than by the
// filer's own pipeline. Per issue #852, this is a cheap pre-filter that
// clears the highest-friction cross-contamination cases at write time.
//
// Returns { ok: true } when the disclosure does not reference an agent
// other than the filer, or when no name pattern is present.
// Returns { ok: false, conflict } when the disclosure names a different
// agent (typically the source of the copy-pasted automation prompt).
export function checkDisclosureIdentity(
  disclosure: string | undefined | null,
  filerDisplayName: string
): { ok: true } | { ok: false; conflict: string } {
  if (!disclosure || typeof disclosure !== "string") return { ok: true };
  if (!filerDisplayName || typeof filerDisplayName !== "string") return { ok: true };

  // Two shapes observed in cross-contamination fixtures:
  //   "<Name> agent, live data from ..."         → 2b96b7ac
  //   "Filed by <Name> — ..."                    → observed in a subset
  const patterns: RegExp[] = [
    /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)\s+agent\b/,
    /\bFiled by\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)\b/,
  ];

  for (const re of patterns) {
    const match = disclosure.match(re);
    if (!match) continue;
    const disclosed = match[1];
    if (disclosed === filerDisplayName) return { ok: true };
    return { ok: false, conflict: disclosed };
  }

  return { ok: true };
}
