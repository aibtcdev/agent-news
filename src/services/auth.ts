/**
 * Bitcoin signature verification service.
 *
 * Supports two signature formats for P2WPKH (bc1q) authentication:
 *
 * 1. BIP-137 compact (65 bytes: header + r + s)
 *    - Used by Electrum, some hardware wallets
 *    - Recovery-based: pubkey recovered from signature
 *
 * 2. BIP-322 witness-serialized (variable length)
 *    - Used by aibtc MCP, modern Bitcoin wallets
 *    - Witness stack: [DER ECDSA sig + hashtype, compressed pubkey]
 *    - Verified via virtual to_spend/to_sign transactions + BIP143 sighash
 *
 * Based on the battle-tested implementation from aibtcdev/landing-page.
 *
 * Message format: "{METHOD} {path}:{timestamp}"
 * e.g. "POST /api/signals:1709500000"
 *
 * Headers: X-BTC-Address, X-BTC-Signature (base64), X-BTC-Timestamp (Unix seconds)
 *
 * KNOWN LIMITATION — P2WPKH (bc1q) addresses only:
 * Taproot (P2TR, bc1p) addresses cannot authenticate. Agents must use a
 * P2WPKH (bc1q) key pair to interact with this API.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import {
  RawWitness,
  RawTx,
  Transaction,
  p2wpkh,
  p2pkh,
  p2sh,
  Script,
  SigHash,
  NETWORK as BTC_MAINNET,
} from "@scure/btc-signer";

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

const TIMESTAMP_WINDOW_SECONDS = 300;
const BITCOIN_MSG_PREFIX = "\x18Bitcoin Signed Message:\n";

// ── Shared helpers ──

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
    const buf = new Uint8Array(3);
    buf[0] = 0xfd;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    return buf;
  }
  if (n <= 0xffffffff) {
    const buf = new Uint8Array(5);
    buf[0] = 0xfe;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    buf[3] = (n >> 16) & 0xff;
    buf[4] = (n >> 24) & 0xff;
    return buf;
  }
  throw new Error("Message too long");
}

function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ── BIP-137 helpers ──

function formatBitcoinMessage(message: string): Uint8Array {
  const prefixBytes = new TextEncoder().encode(BITCOIN_MSG_PREFIX);
  const messageBytes = new TextEncoder().encode(message);
  const lengthBytes = encodeVarInt(messageBytes.length);
  const result = new Uint8Array(prefixBytes.length + lengthBytes.length + messageBytes.length);
  result.set(prefixBytes, 0);
  result.set(lengthBytes, prefixBytes.length);
  result.set(messageBytes, prefixBytes.length + lengthBytes.length);
  return result;
}

function isBip137Signature(sigBytes: Uint8Array): boolean {
  return sigBytes.length === 65 && sigBytes[0] >= 27 && sigBytes[0] <= 42;
}

function getRecoveryIdFromHeader(header: number): number {
  if (header >= 27 && header <= 30) return header - 27;
  if (header >= 31 && header <= 34) return header - 31;
  if (header >= 35 && header <= 38) return header - 35;
  if (header >= 39 && header <= 42) return header - 39;
  throw new Error(`Invalid BIP-137 header byte: ${header}`);
}

// ── BIP-322 helpers ──

/**
 * Convert a DER-encoded ECDSA signature to compact (64-byte r||s) format.
 */
function parseDERSignature(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error("parseDERSignature: expected 0x30 header");
  let pos = 2;
  if (der[pos] !== 0x02) throw new Error("parseDERSignature: expected 0x02 for r");
  pos++;
  const rLen = der[pos++];
  if (pos + rLen > der.length) throw new Error("parseDERSignature: r extends beyond signature");
  const rBytes = der.slice(rLen === 33 ? pos + 1 : pos, pos + rLen);
  pos += rLen;
  if (der[pos] !== 0x02) throw new Error("parseDERSignature: expected 0x02 for s");
  pos++;
  const sLen = der[pos++];
  if (pos + sLen > der.length) throw new Error("parseDERSignature: s extends beyond signature");
  const sBytes = der.slice(sLen === 33 ? pos + 1 : pos, pos + sLen);

  const compact = new Uint8Array(64);
  compact.set(rBytes, 32 - rBytes.length);
  compact.set(sBytes, 64 - sBytes.length);
  return compact;
}

/**
 * BIP-322 tagged hash (spec-compliant): SHA256(SHA256(tag) || SHA256(tag) || msg)
 */
function bip322TaggedHash(message: string): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode("BIP0322-signed-message"));
  const msgBytes = new TextEncoder().encode(message);
  return sha256(concatBytes(tagHash, tagHash, msgBytes));
}

/**
 * BIP-322 tagged hash (legacy): SHA256(SHA256(tag) || SHA256(tag) || varint(len) || msg)
 * Kept for backward compatibility with agents using older signing tools.
 */
function bip322TaggedHashLegacy(message: string): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode("BIP0322-signed-message"));
  const msgBytes = new TextEncoder().encode(message);
  return sha256(concatBytes(tagHash, tagHash, encodeVarInt(msgBytes.length), msgBytes));
}

/**
 * Build the BIP-322 to_spend virtual transaction and return its txid (LE).
 */
function bip322BuildToSpendTxId(message: string, scriptPubKey: Uint8Array, useLegacyHash = false): Uint8Array {
  const msgHash = useLegacyHash ? bip322TaggedHashLegacy(message) : bip322TaggedHash(message);
  const scriptSig = concatBytes(new Uint8Array([0x00, 0x20]), msgHash);

  const rawTx = RawTx.encode({
    version: 0,
    inputs: [{
      txid: new Uint8Array(32),
      index: 0xffffffff,
      finalScriptSig: scriptSig,
      sequence: 0,
    }],
    outputs: [{
      amount: 0n,
      script: scriptPubKey,
    }],
    lockTime: 0,
  });

  return doubleSha256(rawTx).reverse();
}

// ── Signature verification ──

/**
 * BIP-137: 65-byte compact signature with recovery.
 */
function verifyBIP137(address: string, message: string, sigBytes: Uint8Array): boolean {
  const header = sigBytes[0];
  const rBytes = sigBytes.slice(1, 33);
  const sBytes = sigBytes.slice(33, 65);
  const recoveryId = getRecoveryIdFromHeader(header);

  const msgHash = doubleSha256(formatBitcoinMessage(message));
  const r = BigInt("0x" + hex.encode(rBytes));
  const s = BigInt("0x" + hex.encode(sBytes));

  const sig = new secp256k1.Signature(r, s).addRecoveryBit(recoveryId);
  const recoveredPubKey = sig.recoverPublicKey(msgHash).toBytes(true);

  // Derive address based on header byte range
  let derivedAddress: string;
  if (header >= 27 && header <= 34) {
    derivedAddress = p2pkh(recoveredPubKey, BTC_MAINNET).address!;
  } else if (header >= 35 && header <= 38) {
    const inner = p2wpkh(recoveredPubKey, BTC_MAINNET);
    derivedAddress = p2sh(inner, BTC_MAINNET).address!;
  } else {
    derivedAddress = p2wpkh(recoveredPubKey, BTC_MAINNET).address!;
  }

  return derivedAddress === address;
}

/**
 * BIP-322 witness-serialized verification for P2WPKH.
 * Tries spec-compliant hash first, falls back to legacy hash for older signers.
 */
function verifyBIP322Witness(address: string, message: string, sigBytes: Uint8Array): boolean {
  const witnessItems = RawWitness.decode(sigBytes);
  if (witnessItems.length !== 2) return false;

  const ecdsaSigWithHashtype = witnessItems[0];
  const pubkeyBytes = witnessItems[1];
  if (pubkeyBytes.length !== 33) return false;

  const scriptPubKey = p2wpkh(pubkeyBytes, BTC_MAINNET).script;
  const scriptCode = p2pkh(pubkeyBytes).script;

  // Strip hashtype byte, parse DER to compact
  const derSig = ecdsaSigWithHashtype.slice(0, -1);
  const compactSig = parseDERSignature(derSig);

  const verifySighash = (txid: Uint8Array): boolean => {
    const tx = new Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
    tx.addInput({ txid, index: 0, sequence: 0, witnessUtxo: { amount: 0n, script: scriptPubKey } });
    tx.addOutput({ script: Script.encode(["RETURN"]), amount: 0n });
    const sighash = tx.preimageWitnessV0(0, scriptCode, SigHash.ALL, 0n);
    return secp256k1.verify(compactSig, sighash, pubkeyBytes, { prehash: false });
  };

  // Try spec-compliant hash first
  const toSpendTxid = bip322BuildToSpendTxId(message, scriptPubKey);
  if (!verifySighash(toSpendTxid)) {
    // Fall back to legacy tagged hash for older signing tools
    const toSpendTxidLegacy = bip322BuildToSpendTxId(message, scriptPubKey, true);
    if (!verifySighash(toSpendTxidLegacy)) return false;
  }

  // Confirm derived address matches claimed address
  return p2wpkh(pubkeyBytes, BTC_MAINNET).address === address;
}

// ── Public API ──

export function extractAuthHeaders(headers: Headers): AuthHeaders | null {
  const address = headers.get("X-BTC-Address");
  const signature = headers.get("X-BTC-Signature");
  const timestamp = headers.get("X-BTC-Timestamp");
  if (!address || !signature || !timestamp) return null;
  return { address, signature, timestamp };
}

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
 * Verify a Bitcoin message signature for a P2WPKH (bc1q) address.
 * Auto-detects BIP-137 (65-byte compact) vs BIP-322 (witness-serialized) format.
 */
export function verifyBIP322Simple(
  address: string,
  message: string,
  signatureBase64: string
): boolean {
  try {
    const sigBytes = base64ToBytes(signatureBase64);

    if (isBip137Signature(sigBytes)) {
      return verifyBIP137(address, message, sigBytes);
    }

    return verifyBIP322Witness(address, message, sigBytes);
  } catch {
    return false;
  }
}

export function verifyAuth(
  headers: Headers,
  expectedAddress: string,
  method: string,
  path: string
): AuthResult {
  const authHeaders = extractAuthHeaders(headers);
  if (!authHeaders) {
    return {
      valid: false,
      error: "Missing authentication headers: X-BTC-Address, X-BTC-Signature, X-BTC-Timestamp",
      code: "MISSING_AUTH",
    };
  }

  if (!verifyTimestamp(authHeaders.timestamp)) {
    return {
      valid: false,
      error: "Timestamp is outside the allowed window (±5 minutes). Ensure your clock is synced.",
      code: "EXPIRED_TIMESTAMP",
    };
  }

  if (authHeaders.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    return {
      valid: false,
      error: "X-BTC-Address header does not match btc_address in request body",
      code: "ADDRESS_MISMATCH",
    };
  }

  const message = `${method} ${path}:${authHeaders.timestamp}`;
  if (!verifyBIP322Simple(authHeaders.address, message, authHeaders.signature)) {
    return {
      valid: false,
      error: "Invalid signature. Sign the message: \"METHOD /path:timestamp\" using BIP-137 or BIP-322.",
      code: "INVALID_SIGNATURE",
    };
  }

  return { valid: true };
}
