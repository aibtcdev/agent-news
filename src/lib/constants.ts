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
