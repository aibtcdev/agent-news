/**
 * Signal quality auto-scorer v2.
 *
 * Aligned with editor 7-gate framework (Zen Rocket v3.1).
 * Adds tier-1 source domains, structure detection, novelty scoring,
 * specificity checks, and beat-specific keyword density.
 *
 * Pure function — no I/O, no DB. Runs synchronously at submission time.
 */

export interface SignalScoreBreakdown {
  /** 0–25: tier-1 source count + URL specificity */
  sourceQuality: number;
  /** 0–20: headline structure + body length + readability */
  thesisClarity: number;
  /** 0–20: beat-specific keyword density (editor Gate 3 + Gate 5) */
  beatRelevance: number;
  /** 0–15: body structure (CLAIM/EVIDENCE/IMPLICATION) */
  structure: number;
  /** 0–10: novelty indicators in body */
  novelty: number;
  /** 0–10: named entities, PR/issue numbers, on-chain specifics */
  specificity: number;
}

export interface SignalScore {
  /** Composite quality score, 0–100 */
  total: number;
  breakdown: SignalScoreBreakdown;
}

export interface SignalScorerInput {
  headline: string;
  body?: string | null;
  sources: Array<{ url: string; title: string }>;
  tags: string[];
  beat_slug: string;
  disclosure?: string | null;
}

// ── Tier-1 primary source domains (editor Gate 1) ──
const TIER1_DOMAINS = [
  "github.com",
  "arxiv.org",
  "nist.gov",
  "ietf.org",
  "mempool.space",
  "blockstream.info",
  "hiro.so",
  "stacks.co",
  "sec.gov",
  "bis.org",
  "bitcoinops.org",
  "nict.go.jp",
  "eprint.iacr.org",
];

const TIER1_TLDS = [".gov", ".edu", ".ac.uk", ".ac.jp"];

// ── Beat-specific keyword sets (editor Gate 3 + Gate 5) ──
const BEAT_KEYWORDS: Record<string, string[]> = {
  quantum: [
    "quantum", "post-quantum", "pqc", "bip-360", "bip-361", "ecdsa",
    "lattice", "nist", "migration", "shor", "grover", "p2qrh", "p2mr",
    "dilithium", "sphincs", "falcon", "kyber", "ml-kem", "ml-dsa",
    "slh-dsa", "secp256k1", "harvest", "qubit", "post-quantum-cryptography",
    "quantum-resistant", "quantum-safe",
  ],
  "bitcoin-macro": [
    "bitcoin", "btc", "mempool", "difficulty", "hashrate", "fee",
    "mining", "block", "transaction", "inflation", "halving", "etf",
    "institutional", "price", "liquidity", "sats", "lightning",
  ],
  "aibtc-network": [
    "aibtc", "agent", "relay", "x402", "mcp", "signal", "brief",
    "correspondent", "publisher", "sats", "stacks", "sbtc", "payout",
    "nonce", "bip-322", "stx",
  ],
};

// ── Novelty indicator words ──
const NOVELTY_WORDS = [
  "first", "newly", "reveals", "exposes", "uncovered", "demonstrates",
  "proves", "confirms", "shows", "finds", "discloses", "identifies",
  "uncovers", "breaks", "launches", "ships", "merges",
];

// ── Specificity patterns ──
const SPECIFICITY_PATTERNS = [
  /PR\s*#\s*\d+/gi,           // PR #123
  /issue\s*#\s*\d+/gi,        // Issue #456
  /BIP-?\s*\d+/gi,            // BIP-360
  /arxiv[:\s]*\d{4}\.\d+/gi,  // arxiv:2603.01091
  /block\s+\d{6,}/gi,         // Block 946018
  /FIPS\s+\d+/gi,             // FIPS 204
  /0x[0-9a-f]{8,}/gi,         // tx hashes
  /\$[\d,.]+[BMK]?/g,         // dollar amounts
  /[\d,.]+\s*(BTC|sats|STX)/gi, // crypto amounts
  /[\d.]+%/g,                 // percentages
];

// ── Disclosure keywords ──
const DISCLOSURE_KEYWORDS = [
  "claude", "gpt", "gemini", "llm", "ai", "model", "tool", "skill",
  "mcp", "agent", "openai", "anthropic", "mistral", "llama", "groq",
  "hermes", "quiet falcon",
];

// ── Dimension weights (sum = 100) ──
const MAX_SOURCE_QUALITY = 25;
const MAX_THESIS_CLARITY = 20;
const MAX_BEAT_RELEVANCE = 20;
const MAX_STRUCTURE = 15;
const MAX_NOVELTY = 10;
const MAX_SPECIFICITY = 10;

/**
 * Check if a URL is from a tier-1 primary source domain.
 */
function isTier1Source(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    // Direct domain match
    if (TIER1_DOMAINS.some((d) => hostname === d || hostname.endsWith("." + d))) {
      return true;
    }
    // TLD match
    if (TIER1_TLDS.some((tld) => hostname.endsWith(tld))) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if a URL contains a specific path (not just homepage).
 * Homepage-level URLs fail Gate 0 source verification.
 */
function isSpecificUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    // Specific paths: /abs/1234, /pull/123, /api/..., /txid/0x..., /issues/123
    if (/\/(abs|pull|issues|api|txid|blob|commit|releases?|pubs)\/./i.test(path)) {
      return true;
    }
    // Contains year in path (arxiv papers)
    if (/\/\d{4}\.\d+/.test(path)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Score source quality (0–25).
 * Tier-1 sources + URL specificity.
 */
function scoreSourceQuality(sources: Array<{ url: string; title: string }>): number {
  if (sources.length === 0) return 0;

  const tier1Count = sources.filter((s) => isTier1Source(s.url)).length;
  const specificCount = sources.filter((s) => isSpecificUrl(s.url)).length;

  let pts = 0;

  // Base: tier-1 source count
  if (tier1Count >= 3) pts = 20;
  else if (tier1Count === 2) pts = 15;
  else if (tier1Count === 1) pts = 10;
  else pts = 3; // non-tier-1 sources get minimal credit

  // Bonus: specific URLs (not homepage-level)
  if (specificCount >= 2) pts += 5;
  else if (specificCount >= 1) pts += 3;

  return Math.min(pts, MAX_SOURCE_QUALITY);
}

/**
 * Score thesis clarity (0–20).
 * Headline structure + body length + complete sentence.
 */
function scoreThesisClarity(headline: string, body?: string | null): number {
  const words = headline.trim().split(/\s+/).filter((w) => w.length > 0).length;
  let pts = 0;

  // Headline word count: 8–15 = sweet spot
  if (words >= 8 && words <= 15) pts = 10;
  else if (words >= 5 && words <= 20) pts = 7;
  else if (words >= 3) pts = 4;

  // Body length: 500–940 chars = optimal
  if (body) {
    const bodyLen = body.trim().length;
    if (bodyLen >= 500 && bodyLen <= 940) pts += 7;
    else if (bodyLen >= 300) pts += 4;
    else if (bodyLen >= 100) pts += 2;

    // Complete sentence (doesn't end with truncation)
    const lastChar = body.trim().slice(-1);
    if (".!?".includes(lastChar)) pts += 3;
  }

  return Math.min(pts, MAX_THESIS_CLARITY);
}

/**
 * Score beat relevance (0–20).
 * Matches body + tags against beat-specific keyword set.
 */
function scoreBeatRelevance(
  tags: string[],
  beat_slug: string,
  body?: string | null,
  headline?: string
): number {
  const keywords = BEAT_KEYWORDS[beat_slug] || BEAT_KEYWORDS["quantum"];
  const text = [headline, body, ...tags].filter(Boolean).join(" ").toLowerCase();

  let keywordHits = 0;
  const matchedKw = new Set<string>();

  for (const kw of keywords) {
    // Word-boundary match (editor uses \b regex)
    const regex = new RegExp("\\b" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (regex.test(text)) {
      matchedKw.add(kw);
      keywordHits++;
    }
  }

  if (keywordHits >= 10) return MAX_BEAT_RELEVANCE;
  if (keywordHits >= 5) return 15;
  if (keywordHits >= 3) return 10;
  if (keywordHits >= 1) return 5;
  return 0;
}

/**
 * Score structure (0–15).
 * Detects CLAIM/EVIDENCE/IMPLICATION pattern in body.
 */
function scoreStructure(body?: string | null): number {
  if (!body) return 0;
  const upper = body.toUpperCase();

  const hasClaim = /\bCLAIM\b/.test(upper) || /\bCLAIM[:.]/i.test(body);
  const hasEvidence = /\bEVIDENCE\b/.test(upper) || /\bEVIDENCE[:.]/i.test(body);
  const hasImplication =
    /\bIMPLICATION\b/.test(upper) || /\bIMPLICATION[:.]/i.test(body) ||
    /\bACTION\b/.test(upper) || /\bWHAT THIS MEANS\b/i.test(body);

  const sections = [hasClaim, hasEvidence, hasImplication].filter(Boolean).length;

  if (sections === 3) return MAX_STRUCTURE; // Full C/E/I
  if (sections === 2) return 10; // Partial structure
  if (sections === 1) return 5; // Minimal structure
  return 0;
}

/**
 * Score novelty (0–10).
 * Counts novelty indicator words in body.
 */
function scoreNovelty(body?: string | null): number {
  if (!body) return 0;
  const lower = body.toLowerCase();

  let hits = 0;
  for (const word of NOVELTY_WORDS) {
    if (lower.includes(word)) hits++;
  }

  if (hits >= 3) return MAX_NOVELTY;
  if (hits >= 2) return 7;
  if (hits >= 1) return 4;
  return 0;
}

/**
 * Score specificity (0–10).
 * Counts named entities, PR numbers, on-chain specifics.
 */
function scoreSpecificity(body?: string | null, headline?: string): number {
  const text = [headline, body].filter(Boolean).join(" ");
  let matches = 0;

  for (const pattern of SPECIFICITY_PATTERNS) {
    const found = text.match(pattern);
    if (found) matches += found.length;
  }

  if (matches >= 5) return MAX_SPECIFICITY;
  if (matches >= 3) return 7;
  if (matches >= 1) return 4;
  return 0;
}

/**
 * Score a signal and return a composite quality score with per-dimension breakdown.
 */
export function scoreSignal(signal: SignalScorerInput): SignalScore {
  const sourceQuality = scoreSourceQuality(signal.sources);
  const thesisClarity = scoreThesisClarity(signal.headline, signal.body);
  const beatRelevance = scoreBeatRelevance(
    signal.tags,
    signal.beat_slug,
    signal.body,
    signal.headline
  );
  const structure = scoreStructure(signal.body);
  const novelty = scoreNovelty(signal.body);
  const specificity = scoreSpecificity(signal.body, signal.headline);

  const total = sourceQuality + thesisClarity + beatRelevance + structure + novelty + specificity;

  return {
    total,
    breakdown: {
      sourceQuality,
      thesisClarity,
      beatRelevance,
      structure,
      novelty,
      specificity,
    },
  };
}
