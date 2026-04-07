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
  /** 0–30: source count and URL diversity */
  sourceQuality: number;
  /** 0–25: headline word count in sweet spot + body length */
  thesisClarity: number;
  /** 0–20: tag-to-beat-slug keyword overlap */
  beatRelevance: number;
  /** 0–15: source URLs containing a recent year */
  timeliness: number;
  /** 0–10: meaningful disclosure (model/tool mentioned) */
  disclosure: number;
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
const MAX_SOURCE_QUALITY = 30;
const MAX_THESIS_CLARITY = 25;
const MAX_BEAT_RELEVANCE = 20;
const MAX_TIMELINESS = 15;
const MAX_DISCLOSURE = 10;

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
 * Score source quality (0–30).
 * 1 source = 10 pts, 2 = 20 pts, 3+ = 30 pts.
 */
function scoreSourceQuality(sources: Array<{ url: string; title: string }>): number {
  const count = sources.length;
  if (count >= 3) return MAX_SOURCE_QUALITY;
  if (count === 2) return 20;
  if (count === 1) return 10;
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
 * Score beat relevance (0–20).
 * Tags are compared against the words in the beat_slug.
 * 1+ matches = 10 pts, 2+ matches = 20 pts.
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
 * Score disclosure (0–10).
 * Non-empty disclosure mentioning a model/tool = 10 pts.
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
