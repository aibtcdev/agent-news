// BIP-137 Bitcoin message signing for AIBTC News
// Produces signatures verifiable by bitcoin-verify.ts (aibtc-landing)

import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { hmac } from "@noble/hashes/hmac";
import { base58check } from "@scure/base";

// Required by @noble/secp256k1 v2 for deterministic signing (RFC 6979)
secp.etc.hmacSha256Sync = (k, ...m) =>
  hmac(sha256, k, secp.etc.concatBytes(...m));

const BITCOIN_MSG_PREFIX = "\x18Bitcoin Signed Message:\n";

// Encode variable-length integer (Bitcoin varint)
function encodeVarInt(n) {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) {
    const buf = new Uint8Array(3);
    buf[0] = 0xfd;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    return buf;
  }
  throw new Error("Message too long");
}

// Format message per Bitcoin Signed Message protocol
// Matches formatBitcoinMessage() in bitcoin-verify.ts
function formatBitcoinMessage(message) {
  const enc = new TextEncoder();
  const prefixBytes = enc.encode(BITCOIN_MSG_PREFIX);
  const messageBytes = enc.encode(message);
  const lengthBytes = encodeVarInt(messageBytes.length);
  const result = new Uint8Array(
    prefixBytes.length + lengthBytes.length + messageBytes.length
  );
  result.set(prefixBytes, 0);
  result.set(lengthBytes, prefixBytes.length);
  result.set(messageBytes, prefixBytes.length + lengthBytes.length);
  return result;
}

// Double SHA-256 — matches doubleSha256() in bitcoin-verify.ts
function doubleSha256(data) {
  return sha256(sha256(data));
}

// Decode WIF (Wallet Import Format) to raw 32-byte private key
// WIF: base58check(version_byte + 32_key_bytes + [compression_flag])
// base58check.decode() returns payload WITH version byte (checksum already stripped)
function decodeWIF(wif) {
  const decoded = base58check(sha256).decode(wif);
  // Compressed keys (K/L prefix): version(1) + key(32) + compression(1) = 34 bytes
  if (decoded.length === 34) {
    return decoded.slice(1, 33); // strip version byte and compression flag
  }
  // Uncompressed keys (5 prefix): version(1) + key(32) = 33 bytes
  if (decoded.length === 33) {
    return decoded.slice(1); // strip version byte
  }
  throw new Error(`Unexpected WIF payload length: ${decoded.length}`);
}

/**
 * Sign a message using BIP-137 Bitcoin message signing.
 * Produces a base64 signature compatible with bitcoin-verify.ts verification.
 *
 * @param {string} message - The message to sign
 * @param {string} privateKeyWIF - Private key in WIF format (K... or L...)
 * @returns {string} Base64-encoded 65-byte BIP-137 signature
 */
export function signMessage(message, privateKeyWIF) {
  const privKey = decodeWIF(privateKeyWIF);

  // Format and hash the message (same as verification side)
  const formatted = formatBitcoinMessage(message);
  const msgHash = doubleSha256(formatted);

  // Sign with recovery bit
  const sig = secp.sign(msgHash, privKey, { lowS: true });

  // BIP-137 encoding: header byte + r (32 bytes) + s (32 bytes) = 65 bytes
  // Header byte range 39-42 = P2WPKH (bc1q addresses)
  // Matches getRecoveryIdFromHeader() range: header >= 39 && header <= 42
  const headerByte = 39 + sig.recovery;

  const compact = sig.toCompactRawBytes(); // 64 bytes: r || s
  const result = new Uint8Array(65);
  result[0] = headerByte;
  result.set(compact, 1);

  // Base64 encode — 65 bytes → 88-char string
  // Passes validateSignatureFormat() check: base64 chars, length 20-200
  return Buffer.from(result).toString("base64");
}
