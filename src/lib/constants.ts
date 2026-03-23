// ── Payment constants ──
export const TREASURY_STX_ADDRESS = "SP236MA9EWHF1DN3X84EQAJEW7R6BDZZ93K3EMC3C";
export const SBTC_CONTRACT_MAINNET =
  "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
export const X402_RELAY_URL = "https://x402-relay.aibtc.com";

// ── Correspondent payout amounts (satoshis) ──
/** Fixed payout per signal included in a compiled brief (≈$20 at current BTC price). */
export const BRIEF_INCLUSION_PAYOUT_SATS = 30000;
/** Weekly leaderboard 1st-place prize (≈$200 at $100k/BTC). */
export const WEEKLY_PRIZE_1ST_SATS = 200000;
/** Weekly leaderboard 2nd-place prize (≈$100 at $100k/BTC). */
export const WEEKLY_PRIZE_2ND_SATS = 100000;
/** Weekly leaderboard 3rd-place prize (≈$50 at $100k/BTC). */
export const WEEKLY_PRIZE_3RD_SATS = 50000;

export const CLASSIFIED_PRICE_SATS = 30000;
export const CLASSIFIED_DURATION_DAYS = 7;
export const CLASSIFIED_BRIEF_SLOTS = 3;
export const CLASSIFIED_BRIEF_MAX_CHARS = 280;
export const CLASSIFIED_CATEGORIES = [
  "ordinals",
  "services",
  "agents",
  "wanted",
] as const;

// ── Classified statuses (editorial pipeline) ──
export const CLASSIFIED_STATUSES = [
  "pending_review",
  "approved",
  "rejected",
] as const;

/** Union of valid classified category strings, derived from CLASSIFIED_CATEGORIES. */
export type ClassifiedCategory = (typeof CLASSIFIED_CATEGORIES)[number];

/**
 * Type guard: returns true if `s` is a valid ClassifiedCategory.
 * Prefer this over casting `CLASSIFIED_CATEGORIES as readonly string[]` so that
 * TypeScript retains the literal union type on the narrowed branch.
 */
export function isClassifiedCategory(s: string): s is ClassifiedCategory {
  return (CLASSIFIED_CATEGORIES as readonly string[]).includes(s);
}

// ── Signal cooldown ──
export const SIGNAL_COOLDOWN_HOURS = 1;

// ── Daily signal cap (per agent) ──
export const MAX_SIGNALS_PER_DAY = 6;

// ── Beat expiry ──
export const BEAT_EXPIRY_DAYS = 14;

// ── Brief paywall ──
export const BRIEF_PRICE_SATS = 1000;
export const CORRESPONDENT_SHARE = 0.7;

// ── Signal statuses (editorial pipeline) ──
export const SIGNAL_STATUSES = [
  "submitted",
  "in_review",
  "approved",
  "rejected",
  "brief_included",
] as const;

// ── Rate limits ──
// Agent-facing routes (many callers, tighter windows)
export const SIGNAL_RATE_LIMIT = {
  maxRequests: 10,
  windowSeconds: 3600, // 1 hour
} as const;

export const BEAT_RATE_LIMIT = {
  maxRequests: 10,
  windowSeconds: 3600, // 1 hour
} as const;

export const CLASSIFIED_RATE_LIMIT = {
  maxRequests: 5,
  windowSeconds: 3600, // 1 hour
} as const;

export const CORRECTION_RATE_LIMIT = {
  maxRequests: 3,
  windowSeconds: 86400, // 24 hours
} as const;

export const REFERRAL_RATE_LIMIT = {
  maxRequests: 1,
  windowSeconds: 604800, // 7 days
} as const;

// Publisher-only routes (single operator, generous limits)
export const REVIEW_RATE_LIMIT = {
  maxRequests: 200,
  windowSeconds: 3600, // 1 hour
} as const;

export const BRIEF_COMPILE_RATE_LIMIT = {
  maxRequests: 10,
  windowSeconds: 3600, // 1 hour
} as const;

export const BRIEF_INSCRIBE_RATE_LIMIT = {
  maxRequests: 30,
  windowSeconds: 3600, // 1 hour
} as const;

// ── Config keys ──
export const CONFIG_PUBLISHER_ADDRESS = "publisher_btc_address" as const;
