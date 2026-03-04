/**
 * BIP-322 simple signature verification service.
 *
 * Implements endpoint authentication using Bitcoin message signing:
 * - BIP-137 compatible 65-byte signatures (header + r + s) for all address types
 * - P2WPKH (bc1q) address derivation: RIPEMD160(SHA256(pubkey)) + bech32 encoding
 * - Timestamp window: +/- 5 minutes (300 seconds) for replay protection
 *
 * Message format: "{METHOD} {path}:{timestamp}"
 * e.g. "POST /api/signals:1709500000"
 *
 * Headers: X-BTC-Address, X-BTC-Signature (base64), X-BTC-Timestamp (Unix seconds)
 *
 * KNOWN LIMITATION — P2WPKH (bc1q) addresses only:
 * This implementation derives addresses using P2WPKH (native SegWit, bc1q prefix).
 * Agents using Taproot (P2TR, bc1p prefix) addresses cannot authenticate because
 * Taproot uses a different address derivation scheme (tweaked Schnorr public key
 * hashed with bech32m encoding). Attempting to sign with a bc1p address will always
 * result in an ADDRESS_MISMATCH error. Agents must use a P2WPKH (bc1q) key pair
 * to interact with this API.
 */

import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { Signature } from "@noble/secp256k1";

// ── Types ──

export interface AuthHeaders {
  address: string;
  signature: string;
  timestamp: string;
}

export interface AuthResult {
  valid: boolean;
  error?: string;
  code?: "MISSING_AUTH" | "EXPIRED_TIMESTAMP" | "ADDRESS_MISMATCH" | "INVALID_SIGNATURE";
}

// ── Constants ──

/** Default timestamp window: 5 minutes in seconds */
const TIMESTAMP_WINDOW_SECONDS = 300;

/** Bitcoin message signing magic prefix (varint-prefixed) */
const BITCOIN_MSG_PREFIX = "Bitcoin Signed Message:\n";

// ── Bech32 encoder (minimal, P2WPKH only) ──

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) {
    result.push((acc << (toBits - bits)) & maxv);
  }
  return result;
}

/**
 * Encode a P2WPKH address from a 20-byte hash160 value using bech32.
 * Adds witness version 0 prefix and checksum.
 */
function bech32Encode(hrp: string, data: number[]): string {
  const combined = [0, ...data]; // prepend witness version 0
  const hrpExpanded = bech32HrpExpand(hrp);
  const checksumInput = [...hrpExpanded, ...combined, 0, 0, 0, 0, 0, 0];
  const polymod = bech32Polymod(checksumInput) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((polymod >> (5 * (5 - i))) & 31);
  }
  const allData = [...combined, ...checksum];
  return hrp + "1" + allData.map((d) => BECH32_CHARSET[d]).join("");
}

// ── Low-level helpers ──

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function encodeVarInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) {
    return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  }
  return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}

/**
 * Double SHA-256: Bitcoin standard hash for message signing.
 */
function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/**
 * Build the Bitcoin message hash (BIP-137 style).
 * Hash = SHA256(SHA256(prefix || varint(len) || message))
 */
function bitcoinMessageHash(message: string): Uint8Array {
  const enc = new TextEncoder();
  const prefixBytes = enc.encode(BITCOIN_MSG_PREFIX);
  const msgBytes = enc.encode(message);
  const lenBytes = encodeVarInt(msgBytes.length);
  const prefixLen = encodeVarInt(prefixBytes.length);
  const payload = concatBytes(prefixLen, prefixBytes, lenBytes, msgBytes);
  return doubleSha256(payload);
}

/**
 * Derive a P2WPKH bc1q address from a compressed public key.
 * address = bech32("bc", witness_v0, RIPEMD160(SHA256(pubkey)))
 */
function pubkeyToP2WPKHAddress(pubkey: Uint8Array): string {
  const hash160 = ripemd160(sha256(pubkey));
  const converted = convertBits(hash160, 8, 5, true);
  return bech32Encode("bc", converted);
}

// ── Public API ──

/**
 * Extract BIP-322 auth headers from a request.
 * Returns null if any required header is missing.
 */
export function extractAuthHeaders(headers: Headers): AuthHeaders | null {
  const address = headers.get("X-BTC-Address");
  const signature = headers.get("X-BTC-Signature");
  const timestamp = headers.get("X-BTC-Timestamp");
  if (!address || !signature || !timestamp) return null;
  return { address, signature, timestamp };
}

/**
 * Verify the timestamp is within the allowed window.
 * @param timestamp Unix seconds as string
 * @param windowSeconds Allowed window (default 300 = 5 minutes)
 */
export function verifyTimestamp(
  timestamp: string,
  windowSeconds: number = TIMESTAMP_WINDOW_SECONDS
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) <= windowSeconds;
}

/**
 * Verify a BIP-137-compatible Bitcoin signature for a P2WPKH (bc1q) address.
 *
 * The signature is a base64-encoded 65-byte blob: [header, r(32), s(32)].
 * The header byte encodes the address type and recovery ID.
 *   27-30: P2PKH uncompressed
 *   31-34: P2PKH compressed
 *   35-38: P2SH-P2WPKH
 *   39-42: P2WPKH (native SegWit, bc1q)
 *
 * Algorithm:
 * 1. Decode base64 -> 65 bytes
 * 2. Compute message hash: SHA256(SHA256(prefix || varint(len) || message))
 * 3. Recover pubkey from (r, s, recoveryId)
 * 4. Derive P2WPKH address from recovered pubkey
 * 5. Compare derived address to claimed address
 */
export function verifyBIP322Simple(
  address: string,
  message: string,
  signatureBase64: string
): boolean {
  try {
    // Decode base64 signature
    const sigBytes = Uint8Array.from(atob(signatureBase64), (c) => c.charCodeAt(0));
    if (sigBytes.length !== 65) return false;

    const header = sigBytes[0];
    // Only accept headers for P2WPKH (39-42) and P2PKH compressed (31-34)
    // Reject others since we only support bc1q addresses
    if (header < 31 || header > 42) return false;

    // Recovery ID: extracted from header
    let recoveryId: number;
    if (header >= 39 && header <= 42) {
      recoveryId = header - 39; // P2WPKH
    } else if (header >= 35 && header <= 38) {
      recoveryId = header - 35; // P2SH-P2WPKH
    } else {
      recoveryId = header - 31; // P2PKH compressed
    }

    // Extract r and s as big integers
    const rHex = Array.from(sigBytes.slice(1, 33))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const sHex = Array.from(sigBytes.slice(33, 65))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const r = BigInt("0x" + rHex);
    const s = BigInt("0x" + sHex);

    // Compute message hash
    const msgHash = bitcoinMessageHash(message);

    // Recover public key
    const sig = new Signature(r, s, recoveryId);
    const recoveredPoint = sig.recoverPublicKey(msgHash);
    const recoveredPubkey = recoveredPoint.toBytes(true); // compressed

    // Derive P2WPKH address and compare
    const derivedAddress = pubkeyToP2WPKHAddress(recoveredPubkey);
    return derivedAddress === address;
  } catch {
    return false;
  }
}

/**
 * Orchestrate full authentication verification for a request.
 *
 * @param headers Request headers containing auth info
 * @param expectedAddress BTC address from the request body (claimed identity)
 * @param method HTTP method (e.g. "POST")
 * @param path Request path (e.g. "/api/signals")
 */
export function verifyAuth(
  headers: Headers,
  expectedAddress: string,
  method: string,
  path: string
): AuthResult {
  // 1. Extract auth headers
  const authHeaders = extractAuthHeaders(headers);
  if (!authHeaders) {
    return {
      valid: false,
      error: "Missing authentication headers: X-BTC-Address, X-BTC-Signature, X-BTC-Timestamp",
      code: "MISSING_AUTH",
    };
  }

  // 2. Verify timestamp window
  if (!verifyTimestamp(authHeaders.timestamp)) {
    return {
      valid: false,
      error: "Timestamp is outside the allowed window (±5 minutes). Ensure your clock is synced.",
      code: "EXPIRED_TIMESTAMP",
    };
  }

  // 3. Verify address matches expected address from body
  if (authHeaders.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    return {
      valid: false,
      error: "X-BTC-Address header does not match btc_address in request body",
      code: "ADDRESS_MISMATCH",
    };
  }

  // 4. Build and verify the message signature
  const message = `${method} ${path}:${authHeaders.timestamp}`;
  if (!verifyBIP322Simple(authHeaders.address, message, authHeaders.signature)) {
    return {
      valid: false,
      error: "Invalid BIP-322 signature. Sign the message: \"METHOD /path:timestamp\"",
      code: "INVALID_SIGNATURE",
    };
  }

  return { valid: true };
}
