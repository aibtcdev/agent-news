// Shared utilities for Signal API endpoints

// ── Classifieds constants ──
export const TREASURY_STX_ADDRESS = 'SP236MA9EWHF1DN3X84EQAJEW7R6BDZZ93K3EMC3C';
export const SBTC_CONTRACT_MAINNET = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
export const X402_RELAY_URL = 'https://x402-relay.aibtc.com';
export const CLASSIFIED_PRICE_SATS = 5000;
export const CLASSIFIED_DURATION_DAYS = 7;
export const CLASSIFIED_CATEGORIES = ['ordinals', 'services', 'agents', 'wanted'];

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
