/**
 * Signal quality auto-scorer.
 *
 * Scores an incoming signal across five dimensions and returns a 0–100
 * composite score plus a breakdown for publisher review queues.
 *
 * This function is pure (no I/O, no DB) and runs synchronously so it can
 * be called inline inside the signal submission handler with zero overhead.
 */

export interface SignalScoreBreakdown {
  /** 0–20 structural: unique host count only (not verified existence; see #865) */
  sourceQuality: number;
  /** 0–25: headline word count in sweet spot + body length */
  thesisClarity: number;
  /** 0–20: tag-to-beat-slug keyword overlap */
  beatRelevance: number;
  /** 0–15: source URLs containing a recent year */
  timeliness: number;
  /** 0–10: meaningful disclosure (model/tool mentioned) */
  disclosure: number;
  /**
   * Present only when an editor overrode the auto-score at review time (#810).
   * The five axes above reflect the original auto-scorer; `override.previous_score`
   * preserves the composite it produced before the editor replaced it.
   */
  override?: {
    by: string;
    at: string;
    previous_score: number | null;
    reason: string | null;
  };
}

export interface SignalScore {
  /** Composite quality score, 0–100 */
  total: number;
  breakdown: SignalScoreBreakdown;
}

/**
 * Input shape expected by scoreSignal().
 * Mirrors the fields already validated in the signal submission handler.
 */
export interface SignalScorerInput {
  headline: string;
  body?: string | null;
  sources: Array<{ url: string; title: string }>;
  tags: string[];
  beat_slug: string;
  disclosure?: string | null;
}

// ── Dimension weights (must sum to 100) ──
// sourceQuality is STRUCTURAL only (unique hosts). Cap kept low so fabricated
// URL lists cannot print a perfect 100 without other axes (#865 / option 2).
const MAX_SOURCE_QUALITY = 20;
const MAX_THESIS_CLARITY = 25;
const MAX_BEAT_RELEVANCE = 25;
const MAX_TIMELINESS = 15;
const MAX_DISCLOSURE = 15;

/** Keywords that indicate the disclosure mentions an AI model or tool. */
const DISCLOSURE_TOOL_KEYWORDS = [
  "claude",
  "gpt",
  "gemini",
  "llm",
  "ai",
  "model",
  "tool",
  "skill",
  "mcp",
  "agent",
  "openai",
  "anthropic",
  "mistral",
  "llama",
  "groq",
];

/**
 * Score source structure (0–20), NOT verified existence (#865).
 * Uses unique hostnames so three deep-paths on the same host do not max out.
 * 0 hosts = 0, 1 unique host = 8, 2 = 14, 3+ = 20 (capped).
 */
function scoreSourceQuality(sources: Array<{ url: string; title: string }>): number {
  const hosts = new Set<string>();
  for (const s of sources) {
    try {
      const u = new URL(s.url);
      if (u.protocol === "http:" || u.protocol === "https:") {
        hosts.add(u.hostname.toLowerCase());
      }
    } catch {
      // invalid URL contributes no host
    }
  }
  const n = hosts.size;
  if (n >= 3) return MAX_SOURCE_QUALITY;
  if (n === 2) return 14;
  if (n === 1) return 8;
  return 0;
}

/**
 * Score thesis clarity (0–25).
 * Headline word count in 8–15 = 15 pts, 5–7 or 16–20 = 10 pts, else = 5 pts.
 * Body > 200 chars = +10 pts (capped at 25 total).
 */
function scoreThesisClarity(headline: string, body?: string | null): number {
  const words = headline.trim().split(/\s+/).filter((w) => w.length > 0).length;
  let pts = 5;
  if (words >= 8 && words <= 15) {
    pts = 15;
  } else if ((words >= 5 && words <= 7) || (words >= 16 && words <= 20)) {
    pts = 10;
  }

  if (body && body.trim().length > 200) {
    pts += 10;
  }

  return Math.min(pts, MAX_THESIS_CLARITY);
}

/**
 * Score beat relevance (0–25).
 * Tags are compared against the words in the beat_slug.
 * 1 match = 10 pts, 2+ matches = MAX_BEAT_RELEVANCE.
 */
function scoreBeatRelevance(tags: string[], beat_slug: string): number {
  if (tags.length === 0) return 0;

  // Expand beat slug into keywords: "agent-economy" → ["agent", "economy"]
  const beatKeywords = beat_slug
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter((k) => k.length > 2); // Drop 1-2 char fragments (e.g. split artifacts) — real beat keywords are 3+ chars

  const tagSet = new Set(tags.map((t) => t.toLowerCase()));

  let matches = 0;
  for (const kw of beatKeywords) {
    for (const tag of tagSet) {
      if (tag.includes(kw) || kw.includes(tag)) {
        matches++;
        break; // count each keyword at most once
      }
    }
  }

  if (matches >= 2) return MAX_BEAT_RELEVANCE;
  if (matches === 1) return 10;
  return 0;
}

/**
 * Score timeliness (0–15).
 * Any source URL containing the current year (2025 or 2026) = 15 pts, else = 8 pts.
 * Keeps scoring useful even when no date appears in URLs.
 */
function scoreTimeliness(sources: Array<{ url: string; title: string }>): number {
  if (sources.length === 0) return 0;
  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;
  const recentYears = [String(currentYear), String(prevYear)];

  const hasRecent = sources.some((s) =>
    recentYears.some((yr) => s.url.includes(yr))
  );
  return hasRecent ? MAX_TIMELINESS : 8;
}

/**
 * Score disclosure (0–15).
 * Non-empty disclosure mentioning a model/tool = MAX_DISCLOSURE pts.
 * Non-empty but generic = 5 pts.
 * Empty = 0 pts.
 */
function scoreDisclosure(disclosure?: string | null): number {
  if (!disclosure || disclosure.trim().length === 0) return 0;
  const lower = disclosure.toLowerCase();
  const mentionsToolOrModel = DISCLOSURE_TOOL_KEYWORDS.some((kw) =>
    lower.includes(kw)
  );
  return mentionsToolOrModel ? MAX_DISCLOSURE : 5;
}

/**
 * Score a signal and return a composite quality score with per-dimension breakdown.
 *
 * @param signal - The signal fields to evaluate (no I/O required).
 * @returns A SignalScore with a 0–100 total and a breakdown.
 */
export function scoreSignal(signal: SignalScorerInput): SignalScore {
  const sourceQuality = scoreSourceQuality(signal.sources);
  const thesisClarity = scoreThesisClarity(signal.headline, signal.body);
  const beatRelevance = scoreBeatRelevance(signal.tags, signal.beat_slug);
  const timeliness = scoreTimeliness(signal.sources);
  const disclosure = scoreDisclosure(signal.disclosure);

  const total = sourceQuality + thesisClarity + beatRelevance + timeliness + disclosure;

  return {
    total,
    breakdown: {
      sourceQuality,
      thesisClarity,
      beatRelevance,
      timeliness,
      disclosure,
    },
  };
}

/**
 * Merge an editor score-override provenance envelope into an existing
 * score_breakdown JSON string, returning the new JSON string to persist (#810).
 *
 * The original auto-scorer axes are preserved untouched; the `override` field
 * records who changed the score, when, the previous composite, and why. A
 * malformed or absent prior breakdown degrades to an empty object so an override
 * is never blocked by unparseable legacy data.
 */
export function withScoreOverride(
  priorBreakdownJson: string | null,
  override: NonNullable<SignalScoreBreakdown["override"]>
): string {
  let prior: Record<string, unknown> = {};
  if (priorBreakdownJson) {
    try {
      const parsed = JSON.parse(priorBreakdownJson) as unknown;
      if (parsed && typeof parsed === "object") {
        prior = parsed as Record<string, unknown>;
      }
    } catch {
      prior = {};
    }
  }
  return JSON.stringify({ ...prior, override });
}
