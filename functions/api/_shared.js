// Shared utilities for Signal API endpoints

// ── Pacific timezone helpers ──
const PACIFIC_TZ = 'America/Los_Angeles';

export function getPacificDate(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: PACIFIC_TZ });
}

export function getPacificYesterday(now = new Date()) {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return getPacificDate(yesterday);
}

export function formatPacificShort(isoStr) {
  return new Date(isoStr).toLocaleString('en-US', {
    timeZone: PACIFIC_TZ,
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ── Payment constants ──
export const TREASURY_STX_ADDRESS = 'SP236MA9EWHF1DN3X84EQAJEW7R6BDZZ93K3EMC3C';
export const SBTC_CONTRACT_MAINNET = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
export const X402_RELAY_URL = 'https://x402-relay.aibtc.com';
export const BRIEF_PRICE_SATS = 1000;
export const CORRESPONDENT_SHARE = 0.7;
export const CLASSIFIED_PRICE_SATS = 5000;
export const CLASSIFIED_DURATION_DAYS = 7;
export const CLASSIFIED_CATEGORIES = ['ordinals', 'services', 'agents', 'wanted'];

// ── Bounty constants ──
export const BOUNTY_MAX_TITLE = 200;
export const BOUNTY_MAX_DESCRIPTION = 2000;
export const BOUNTY_MAX_TAGS = 500;
export const BOUNTY_STATUSES = ['open', 'claimed', 'submitted', 'approved', 'paid', 'cancelled'];

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function json(data, opts = {}) {
  const status = opts.status || 200;
  const cache = opts.cache || 0;
  const headers = { ...CORS };
  if (cache > 0) headers['Cache-Control'] = `public, max-age=${cache}`;
  return Response.json(data, { status, headers });
}

export function err(message, status = 400, hint) {
  const body = { error: message };
  if (hint) body.hint = hint;
  return Response.json(body, { status, headers: CORS });
}

export function options() {
  return new Response(null, { headers: CORS });
}

export function methodNotAllowed() {
  return err('Method not allowed', 405);
}

// ── ID format validators (for KV key safety) ──

export function validateId(id) {
  if (!id || typeof id !== 'string') return false;
  return /^[a-zA-Z0-9_-]{1,100}$/.test(id);
}

// ── Validation utilities ──

export function validateBtcAddress(addr) {
  if (!addr || typeof addr !== 'string') return false;
  return /^bc1[a-zA-HJ-NP-Z0-9]{25,87}$/.test(addr);
}

export function validateSlug(slug) {
  if (!slug || typeof slug !== 'string') return false;
  return /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug) || /^[a-z0-9]{3}$/.test(slug);
}

export function validateHexColor(color) {
  if (!color || typeof color !== 'string') return false;
  return /^#[0-9a-fA-F]{6}$/.test(color);
}

export function sanitizeString(str, max = 500) {
  if (!str || typeof str !== 'string') return '';
  return str.trim().slice(0, max);
}

// ── Structured signal field validators ──

export const BEAT_EXPIRY_DAYS = 14;

export function validateHeadline(str) {
  if (!str || typeof str !== 'string') return false;
  const trimmed = str.trim();
  return trimmed.length >= 1 && trimmed.length <= 120;
}

export function validateSources(arr) {
  if (!Array.isArray(arr)) return false;
  if (arr.length === 0 || arr.length > 5) return false;
  return arr.every(s =>
    s && typeof s === 'object' &&
    typeof s.url === 'string' && s.url.length > 0 && s.url.length <= 500 &&
    typeof s.title === 'string' && s.title.length > 0 && s.title.length <= 200
  );
}

export function validateTags(arr) {
  if (!Array.isArray(arr)) return false;
  if (arr.length === 0 || arr.length > 10) return false;
  return arr.every(t =>
    typeof t === 'string' && /^[a-z0-9-]{2,30}$/.test(t)
  );
}

export function validateSignatureFormat(signature) {
  if (!signature || typeof signature !== 'string') return false;
  if (signature.length < 20 || signature.length > 200) return false;
  return /^[A-Za-z0-9+/=]+$/.test(signature);
}

// ── Per-IP rate limiting ──

export async function checkIPRateLimit(kv, request, { key, maxRequests, windowSeconds }) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey = `ratelimit:${key}:${ip}`;
  const record = (await kv.get(rlKey, 'json')) || { count: 0, resetAt: 0 };
  const now = Date.now();

  if (now > record.resetAt) {
    // Window expired, start fresh
    record.count = 1;
    record.resetAt = now + windowSeconds * 1000;
  } else {
    record.count += 1;
  }

  if (record.count > maxRequests) {
    const retryAfter = Math.ceil((record.resetAt - now) / 1000);
    return err(`Rate limited. Try again in ${retryAfter}s`, 429);
  }

  await kv.put(rlKey, JSON.stringify(record), { expirationTtl: windowSeconds });
  return null;
}
