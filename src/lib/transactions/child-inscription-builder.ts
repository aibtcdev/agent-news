/**
 * Child Inscription Builder
 *
 * Builds Bitcoin commit + reveal transaction pairs for inscribing AIBTC News
 * daily briefs as child inscriptions of the genesis parent inscription.
 *
 * Architecture: ordinals commit/reveal model
 * ─────────────────────────────────────────
 * 1. Commit tx: pays to a P2TR script-path address whose leaf script embeds
 *    the inscription envelope (OP_FALSE OP_IF … OP_ENDIF wrapped in tapscript).
 * 2. Reveal tx: spends the commit output via script-path AND spends the parent
 *    UTXO via key-path (to satisfy the child inscription requirement).
 *
 * The reveal tx has two inputs:
 *   [0] commit UTXO — script-path spend, signed with tapLeafScript
 *   [1] parent UTXO — key-path spend, signed with tapInternalKey
 *
 * Both inputs are signed with the same taproot private key.
 *
 * Dependencies: @scure/btc-signer ^2.0.1, @noble/hashes ^2.0.1
 */

import { Transaction, p2tr, NETWORK, TAPROOT_UNSPENDABLE_KEY } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

// ── Constants ─────────────────────────────────────────────────────────────────

/** MIME type for plain-text brief inscriptions */
export const INSCRIPTION_CONTENT_TYPE = "text/plain;charset=utf-8";

/** Ordinal envelope opcodes (from the ordinals protocol) */
const OP_0 = 0x00; // also OP_FALSE — pushes empty vector
const OP_IF = 0x63;
const OP_PUSH_1 = 0x01;
const OP_PUSH_3 = 0x03;
const OP_ENDIF = 0x68;
const OP_CHECKSIG = 0xac;

// Ordinal envelope marker
const INSCRIPTION_MARKER = new TextEncoder().encode("ord");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UTXO {
  txid: string;
  vout: number;
  value: number; // satoshis
}

export interface CommitTxResult {
  /** The unsigned commit transaction object */
  tx: Transaction;
  /** The P2TR address to fund the commit output */
  commitAddress: string;
  /** The script used in the tapscript leaf */
  inscriptionScript: Uint8Array;
  /** The commit output amount in satoshis (content size + fee estimate) */
  commitAmount: bigint;
}

export interface RevealTxResult {
  /** The signed reveal transaction object */
  tx: Transaction;
  /** The reveal transaction hex */
  hex: string;
}

export interface BuildChildInscriptionParams {
  /** Content of the inscription (brief text or JSON) */
  content: string;
  /** MIME type, defaults to text/plain;charset=utf-8 */
  contentType?: string;
  /** Fee rate in sat/vByte */
  feeRate: number;
  /** The publisher's taproot private key (32 bytes) */
  privateKey: Uint8Array;
  /** UTXO holding the parent inscription (must be a P2TR UTXO) */
  parentUtxo: UTXO;
  /** Fee UTXOs (cardinal UTXOs to fund the commit tx) */
  feeUtxos: UTXO[];
  /** Destination address for change output */
  changeAddress: string;
}

// ── Inscription Script Builder ────────────────────────────────────────────────

/**
 * Build an ordinals inscription envelope as a tapscript.
 *
 * Structure (from the ordinals protocol spec):
 *   <pubkey> OP_CHECKSIG
 *   OP_FALSE OP_IF
 *     OP_PUSH "ord"
 *     OP_PUSH_1 OP_PUSH <content-type>
 *     OP_0                               ← body separator (pushes empty vector)
 *     OP_PUSH <content-chunk-1>
 *     [OP_PUSH <content-chunk-n> ...]
 *   OP_ENDIF
 *
 * The pubkey + OP_CHECKSIG is the spending condition. The OP_FALSE OP_IF block
 * is a "dead branch" that stores arbitrary data in the witness.
 */
export function buildInscriptionScript(
  pubKey: Uint8Array,
  contentType: string,
  content: Uint8Array
): Uint8Array {
  const encoder = new TextEncoder();
  const contentTypeBytes = encoder.encode(contentType);

  // Build the script byte-by-byte
  const parts: number[] = [];

  // Spending condition prefix: <pubkey> OP_CHECKSIG
  // (placed before the envelope so the script path works as a key spend alternative)
  parts.push(pubKey.length);
  parts.push(...pubKey);
  parts.push(OP_CHECKSIG);

  // Ordinal envelope: OP_0 OP_IF (OP_0 = OP_FALSE)
  parts.push(OP_0);
  parts.push(OP_IF);

  // Push "ord" marker
  parts.push(OP_PUSH_3);
  parts.push(...INSCRIPTION_MARKER);

  // Field 1: content-type (tag 0x01)
  parts.push(OP_PUSH_1);
  parts.push(OP_PUSH_1);
  parts.push(...pushData(contentTypeBytes));

  // Body separator: OP_0 pushes empty vector (ordinals protocol convention)
  parts.push(OP_0);

  // Content data: push in 520-byte chunks (max script push size)
  const CHUNK_SIZE = 520;
  for (let offset = 0; offset < content.length; offset += CHUNK_SIZE) {
    const chunk = content.slice(offset, offset + CHUNK_SIZE);
    parts.push(...pushData(chunk));
  }

  // OP_ENDIF
  parts.push(OP_ENDIF);

  return new Uint8Array(parts);
}

/**
 * Encode a byte array as a minimal script push operation.
 * Returns the length prefix + data bytes.
 */
function pushData(data: Uint8Array): number[] {
  const len = data.length;
  const result: number[] = [];

  if (len === 0) {
    result.push(OP_0);
  } else if (len <= 75) {
    result.push(len);
    result.push(...data);
  } else if (len <= 255) {
    result.push(0x4c); // OP_PUSHDATA1
    result.push(len);
    result.push(...data);
  } else if (len <= 65535) {
    result.push(0x4d); // OP_PUSHDATA2
    result.push(len & 0xff);
    result.push((len >> 8) & 0xff);
    result.push(...data);
  } else {
    throw new Error(`pushData: data too large (${len} bytes)`);
  }

  return result;
}

// ── Fee Estimation ────────────────────────────────────────────────────────────

/**
 * Estimate the virtual size of the reveal transaction in vBytes.
 *
 * Reveal tx structure:
 *   - 1 input: commit UTXO (P2TR script-path, ~300 vBytes witness)
 *   - 1 input: parent UTXO (P2TR key-path, 57.5 vBytes witness)
 *   - 1 output: inscription (P2TR, 43 vBytes)
 *   - 1 output (optional): change (P2TR, 43 vBytes)
 *
 * Base: 10 vBytes overhead
 * Input 0 (script-path): 41 (non-witness) + ~300 (witness) / 4 = ~116 vBytes
 * Input 1 (key-path): 41 (non-witness) + 65 (witness) / 4 = ~57 vBytes
 * Output: 43 vBytes
 */
export function estimateRevealVBytes(contentLength: number): number {
  const base = 10;
  const commitInputNonWitness = 41;
  const commitInputWitnessVBytes = Math.ceil((contentLength + 200) / 4); // ~200B overhead
  const parentInputNonWitness = 41;
  const parentInputWitnessVBytes = Math.ceil(65 / 4); // ~65B witness for key-path
  const outputVBytes = 43;

  return (
    base +
    commitInputNonWitness +
    commitInputWitnessVBytes +
    parentInputNonWitness +
    parentInputWitnessVBytes +
    outputVBytes
  );
}

/**
 * Estimate the virtual size of the commit transaction in vBytes.
 */
export function estimateCommitVBytes(numFeeInputs: number): number {
  const base = 10;
  const inputVBytes = numFeeInputs * 57; // P2TR key-path inputs
  const outputVBytes = 43 + 43; // commit output + change output
  return base + inputVBytes + outputVBytes;
}

// ── Commit Transaction Builder ────────────────────────────────────────────────

/**
 * Build the commit transaction that funds the inscription envelope address.
 *
 * The commit tx pays to a P2TR script-path address derived from a tapscript
 * that embeds the inscription content. This "commits" to the inscription data
 * before it's revealed in the reveal transaction.
 *
 * @param params - inscription parameters
 * @returns CommitTxResult with the unsigned transaction and commit address
 */
export function buildChildCommitTransaction(
  params: BuildChildInscriptionParams
): CommitTxResult {
  const { content, contentType = INSCRIPTION_CONTENT_TYPE, feeRate, privateKey, feeUtxos } = params;

  // Derive x-only public key from private key
  const pubKeyFull = schnorr.getPublicKey(privateKey);
  const xOnlyPubKey = pubKeyFull.slice(0, 32); // x-only = first 32 bytes

  // Build the inscription tapscript
  const contentBytes = new TextEncoder().encode(content);
  const inscriptionScript = buildInscriptionScript(xOnlyPubKey, contentType, contentBytes);

  // Create the P2TR commit address (script-path spend)
  // The script tree contains a single leaf: the inscription script.
  // TAPROOT_UNSPENDABLE_KEY is the canonical NUMS (Nothing-Up-My-Sleeve) point
  // used when the key-path should be provably unspendable.
  const commitP2tr = p2tr(
    TAPROOT_UNSPENDABLE_KEY,
    { script: inscriptionScript },
    NETWORK
  );

  // Estimate fees
  const revealVBytes = estimateRevealVBytes(contentBytes.length);
  const commitVBytes = estimateCommitVBytes(feeUtxos.length);

  const revealFee = BigInt(Math.ceil(revealVBytes * feeRate));
  const commitFee = BigInt(Math.ceil(commitVBytes * feeRate));

  // Commit output must cover: inscription dust (546 sats) + reveal fee
  const DUST_LIMIT = 546n;
  const commitAmount = DUST_LIMIT + revealFee;

  // Build the commit transaction
  const tx = new Transaction();

  // Add fee inputs
  for (const utxo of feeUtxos) {
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: p2tr(xOnlyPubKey, undefined, NETWORK).script,
        amount: BigInt(utxo.value),
      },
      tapInternalKey: xOnlyPubKey,
    });
  }

  // Add commit output (pays to the inscription P2TR address)
  tx.addOutput({
    script: commitP2tr.script,
    amount: commitAmount,
  });

  // Compute total input value
  const totalIn = feeUtxos.reduce((sum, u) => sum + BigInt(u.value), 0n);
  const change = totalIn - commitAmount - commitFee;

  if (change < 0n) {
    throw new Error(
      `Insufficient funds: need ${commitAmount + commitFee} sats, have ${totalIn} sats`
    );
  }

  // Add change output if above dust
  if (change >= DUST_LIMIT) {
    const changeP2tr = p2tr(xOnlyPubKey, undefined, NETWORK);
    tx.addOutput({
      script: changeP2tr.script,
      amount: change,
    });
  }

  return {
    tx,
    commitAddress: commitP2tr.address ?? (() => { throw new Error("Failed to derive commit P2TR address"); })(),
    inscriptionScript,
    commitAmount,
  };
}

// ── Reveal Transaction Builder ────────────────────────────────────────────────

/**
 * Build and sign the reveal transaction for a child inscription.
 *
 * The reveal tx spends two inputs:
 *   [0] commit UTXO (script-path spend via tapLeafScript)
 *   [1] parent UTXO (key-path spend via tapInternalKey) ← BUG FIX: was missing tapInternalKey
 *
 * Without `tapInternalKey` on the parent input, @scure/btc-signer cannot
 * match the private key to the input during signing. The `tx.sign()` call
 * signs zero inputs, and `tx.finalize()` throws "finalize/taproot: unknown input."
 *
 * See: https://github.com/aibtcdev/agent-news/issues/188
 *
 * @param privateKey - 32-byte taproot private key (controls both inputs)
 * @param commitUtxo - the UTXO created by the commit transaction
 * @param commitTxResult - the result from buildChildCommitTransaction
 * @param parentUtxo - the UTXO holding the parent inscription
 * @param changeAddress - destination for any leftover sats
 * @param feeRate - fee rate in sat/vByte
 * @returns signed reveal transaction ready to broadcast
 */
export function buildChildRevealTransaction(
  privateKey: Uint8Array,
  commitUtxo: UTXO,
  commitTxResult: CommitTxResult,
  parentUtxo: UTXO,
  changeAddress: string,
  feeRate: number
): RevealTxResult {
  const { inscriptionScript, commitAmount } = commitTxResult;

  // Derive x-only public key from the private key
  const pubKeyFull = schnorr.getPublicKey(privateKey);
  const xOnlyPubKey = pubKeyFull.slice(0, 32);

  // Derive public key bytes for x-only representation
  const xOnlyParentPubKey = xOnlyPubKey;

  // The commit P2TR (script-path spend)
  // TAPROOT_UNSPENDABLE_KEY ensures the key-path is provably unspendable
  const commitP2tr = p2tr(
    TAPROOT_UNSPENDABLE_KEY,
    { script: inscriptionScript },
    NETWORK
  );

  // The parent P2TR (key-path spend)
  const parentP2tr = p2tr(xOnlyParentPubKey, undefined, NETWORK);

  // Build the reveal transaction
  const tx = new Transaction();

  // Input [0]: commit UTXO — script-path spend
  // tapLeafScript tells the signer which leaf script to use for signing
  tx.addInput({
    txid: commitUtxo.txid,
    index: commitUtxo.vout,
    witnessUtxo: {
      script: commitP2tr.script,
      amount: commitAmount,
    },
    tapLeafScript: commitP2tr.tapLeafScript,
  });

  // Input [1]: parent inscription UTXO — key-path spend
  //
  // FIX (issue #188): tapInternalKey is required for key-path taproot spends.
  // Without it, @scure/btc-signer cannot determine which key controls this
  // input during tx.sign(), resulting in zero inputs signed and a
  // "finalize/taproot: unknown input" error from tx.finalize().
  tx.addInput({
    txid: parentUtxo.txid,
    index: parentUtxo.vout,
    witnessUtxo: {
      script: parentP2tr.script,
      amount: BigInt(parentUtxo.value),
    },
    tapInternalKey: xOnlyParentPubKey,
  });

  // Output: inscription recipient (the reveal address for this inscription)
  // For child inscriptions, the output goes to the publisher's address
  const recipientP2tr = p2tr(xOnlyParentPubKey, undefined, NETWORK);

  // Estimate fee for the reveal tx
  const contentLength = inscriptionScript.length;
  const revealVBytes = estimateRevealVBytes(contentLength);
  const revealFee = BigInt(Math.ceil(revealVBytes * feeRate));

  // Inscription output: 546 sat dust limit
  const DUST_LIMIT = 546n;
  const totalIn = commitAmount + BigInt(parentUtxo.value);
  const outputAmount = DUST_LIMIT;
  const change = totalIn - outputAmount - revealFee;

  // Output [0]: the inscription itself
  tx.addOutput({
    script: recipientP2tr.script,
    amount: outputAmount,
  });

  // Output [1]: change back to publisher
  if (change >= DUST_LIMIT) {
    const changeP2tr = p2tr(xOnlyParentPubKey, undefined, NETWORK);
    tx.addOutput({
      script: changeP2tr.script,
      amount: change,
    });
  }

  // Sign both inputs with the taproot private key
  // Input [0] is signed via script-path (tapLeafScript provides context)
  // Input [1] is signed via key-path (tapInternalKey provides context)
  tx.sign(privateKey);
  tx.finalize();

  return {
    tx,
    hex: tx.hex,
  };
}

// ── Convenience: Full Build Pipeline ─────────────────────────────────────────

/**
 * Build and sign both the commit and reveal transactions for a child inscription.
 *
 * This is the main entry point for agents performing the inscription handoff.
 * The commit tx must be broadcast and confirmed before the reveal tx is sent.
 *
 * @param params - inscription parameters (see BuildChildInscriptionParams)
 * @param commitConfirmedUtxo - the confirmed UTXO from the broadcast commit tx
 * @returns { commitTx, revealTx } — commit is unsigned; reveal is signed
 */
export function buildChildInscriptionPair(
  params: BuildChildInscriptionParams,
  commitConfirmedUtxo?: UTXO
): { commitResult: CommitTxResult; revealResult?: RevealTxResult } {
  const commitResult = buildChildCommitTransaction(params);

  if (!commitConfirmedUtxo) {
    // Return only the commit tx — caller must broadcast it, wait for confirmation,
    // then call buildChildRevealTransaction with the confirmed UTXO.
    return { commitResult };
  }

  const revealResult = buildChildRevealTransaction(
    params.privateKey,
    commitConfirmedUtxo,
    commitResult,
    params.parentUtxo,
    params.changeAddress,
    params.feeRate
  );

  return { commitResult, revealResult };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Derive the x-only public key from a 32-byte taproot private key.
 * Used to verify the key before building transactions.
 */
export function deriveXOnlyPubKey(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 32) {
    throw new Error(`Invalid private key length: ${privateKey.length} (expected 32)`);
  }
  const pubKey = schnorr.getPublicKey(privateKey);
  return pubKey.slice(0, 32);
}

/**
 * Compute the content hash for a given brief content string.
 * Used to verify the content has not been modified after commitment.
 */
export function computeContentHash(content: string): string {
  const contentBytes = new TextEncoder().encode(content);
  const hash = sha256(contentBytes);
  return hex.encode(hash);
}

/**
 * Estimate the total fee in satoshis for a complete commit+reveal inscription.
 */
export function estimateTotalInscriptionFee(
  contentLength: number,
  feeRate: number,
  numFeeInputs = 1
): { commitFee: number; revealFee: number; totalFee: number } {
  const commitVBytes = estimateCommitVBytes(numFeeInputs);
  const revealVBytes = estimateRevealVBytes(contentLength);

  const commitFee = Math.ceil(commitVBytes * feeRate);
  const revealFee = Math.ceil(revealVBytes * feeRate);

  return {
    commitFee,
    revealFee,
    totalFee: commitFee + revealFee,
  };
}
