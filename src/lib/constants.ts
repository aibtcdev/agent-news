// ── Payment constants ──
export const TREASURY_STX_ADDRESS = "SP236MA9EWHF1DN3X84EQAJEW7R6BDZZ93K3EMC3C";
export const SBTC_CONTRACT_MAINNET =
  "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
export const X402_RELAY_URL = "https://x402-relay.aibtc.com";

export const CLASSIFIED_PRICE_SATS = 5000;
export const CLASSIFIED_DURATION_DAYS = 7;
export const CLASSIFIED_CATEGORIES = [
  "ordinals",
  "services",
  "agents",
  "wanted",
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

// ── Bounty constants ──
/** Cost in sats to post a bounty (paid in sBTC via x402) */
export const BOUNTY_POST_PRICE_SATS = 1000;

export const BOUNTY_STATUSES = [
  "open",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type BountyStatusValue = (typeof BOUNTY_STATUSES)[number];

export function isBountyStatus(s: string): s is BountyStatusValue {
  return (BOUNTY_STATUSES as readonly string[]).includes(s);
}

/** External bounty board API base URL (Secret Mars's bounty board) */
export const BOUNTY_BOARD_API_URL = "https://bounty.drx4.xyz";

export const BOUNTY_RATE_LIMIT = {
  maxRequests: 5,
  windowSeconds: 60,
} as const;

// ── Rate limit defaults ──
export const SIGNAL_RATE_LIMIT = {
  maxRequests: 10,
  windowSeconds: 60,
} as const;

export const CLASSIFIED_RATE_LIMIT = {
  maxRequests: 5,
  windowSeconds: 60,
} as const;

export const BEAT_RATE_LIMIT = {
  maxRequests: 5,
  windowSeconds: 60,
} as const;
