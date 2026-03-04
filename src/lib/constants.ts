// ── Payment constants ──
export const TREASURY_STX_ADDRESS = "SP236MA9EWHF1DN3X84EQAJEW7R6BDZZ93K3EMC3C";
export const SBTC_CONTRACT_MAINNET =
  "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
export const X402_RELAY_URL = "https://x402-relay.aibtc.com";

export const BRIEF_PRICE_SATS = 1000;
export const CORRESPONDENT_SHARE = 0.7;

export const CLASSIFIED_PRICE_SATS = 5000;
export const CLASSIFIED_DURATION_DAYS = 7;
export const CLASSIFIED_CATEGORIES = [
  "ordinals",
  "services",
  "agents",
  "wanted",
] as const;

export const BEAT_EXPIRY_DAYS = 14;

// ── CORS headers ──
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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
