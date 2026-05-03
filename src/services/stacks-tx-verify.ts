/**
 * Stacks transaction verifier — used by the wallet-driven classifieds flow.
 *
 * Independent of the x402 relay path. Given a txid that the user's wallet
 * broadcast, fetch the canonical record from the Hiro Stacks API and confirm
 * it really is a successful sBTC transfer of the expected amount to the
 * treasury principal. The caller is responsible for replay protection.
 */

import {
  SBTC_CONTRACT_MAINNET,
  TREASURY_STX_ADDRESS,
} from "../lib/constants";
import type { Logger } from "../lib/types";

const HIRO_TX_URL = "https://api.hiro.so/extended/v1/tx";
const HIRO_TIMEOUT_MS = 8_000;

export type TxVerifyErrorCode =
  | "TX_NOT_FOUND"
  | "TX_PENDING"
  | "TX_ABORTED"
  | "WRONG_CONTRACT"
  | "WRONG_FUNCTION"
  | "WRONG_RECIPIENT"
  | "WRONG_ASSET"
  | "INSUFFICIENT_AMOUNT"
  | "MALFORMED_TX"
  | "HIRO_UNAVAILABLE";

export type TxVerifyResult =
  | {
      ok: true;
      sender: string;
      amount: number;
      txid: string;
      blockHeight: number | null;
    }
  | {
      ok: false;
      code: TxVerifyErrorCode;
      reason: string;
    };

export interface VerifyOptions {
  logger?: Logger;
  /** Override Hiro fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Override the expected recipient (defaults to TREASURY_STX_ADDRESS). */
  expectedRecipient?: string;
  /** Override the expected sBTC contract id (defaults to mainnet). */
  expectedContractId?: string;
}

interface HiroFtAssetEvent {
  event_type?: string;
  asset?: {
    asset_event_type?: string;
    asset_id?: string;
    sender?: string;
    recipient?: string;
    amount?: string;
  };
}

interface HiroTxResponse {
  tx_id?: string;
  tx_status?: string;
  tx_type?: string;
  sender_address?: string;
  block_height?: number;
  contract_call?: {
    contract_id?: string;
    function_name?: string;
  };
  events?: HiroFtAssetEvent[];
}

const TERMINAL_FAILURE_STATUSES = new Set([
  "abort_by_response",
  "abort_by_post_condition",
  "dropped_replace_by_fee",
  "dropped_replace_across_fork",
  "dropped_too_expensive",
  "dropped_stale_garbage_collect",
  "dropped_problematic",
]);

function normalizeTxid(input: string): string {
  const trimmed = input.trim().toLowerCase();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

/**
 * Verify that a Stacks txid is a confirmed sBTC transfer to the treasury for
 * at least `requiredAmount` sats. Returns sender + actual transferred amount.
 */
export async function verifySbtcTransferTxid(
  rawTxid: string,
  requiredAmount: number,
  options: VerifyOptions = {}
): Promise<TxVerifyResult> {
  const txid = normalizeTxid(rawTxid);
  const expectedRecipient = options.expectedRecipient ?? TREASURY_STX_ADDRESS;
  const expectedContractId = options.expectedContractId ?? SBTC_CONTRACT_MAINNET;
  const fetchFn = options.fetchImpl ?? fetch;
  const logger = options.logger;

  let response: Response;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HIRO_TIMEOUT_MS);
    try {
      response = await fetchFn(`${HIRO_TX_URL}/${encodeURIComponent(txid)}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    logger?.warn("hiro tx fetch failed", { txid, error: String(err) });
    return { ok: false, code: "HIRO_UNAVAILABLE", reason: "Could not reach the Stacks API to verify your transaction." };
  }

  if (response.status === 404) {
    return { ok: false, code: "TX_NOT_FOUND", reason: "Transaction not found on the Stacks network yet." };
  }

  if (response.status >= 500) {
    return { ok: false, code: "HIRO_UNAVAILABLE", reason: `Stacks API returned ${response.status}.` };
  }

  if (!response.ok) {
    return { ok: false, code: "MALFORMED_TX", reason: `Stacks API rejected lookup with status ${response.status}.` };
  }

  let body: HiroTxResponse;
  try {
    body = (await response.json()) as HiroTxResponse;
  } catch {
    return { ok: false, code: "HIRO_UNAVAILABLE", reason: "Stacks API returned an unparseable response." };
  }

  const status = body.tx_status;
  if (status === "pending") {
    return { ok: false, code: "TX_PENDING", reason: "Transaction is still in the mempool." };
  }

  if (!status || (status !== "success" && !TERMINAL_FAILURE_STATUSES.has(status))) {
    return { ok: false, code: "TX_PENDING", reason: `Transaction status is "${status ?? "unknown"}".` };
  }

  if (TERMINAL_FAILURE_STATUSES.has(status)) {
    return { ok: false, code: "TX_ABORTED", reason: `Transaction failed on-chain (${status}).` };
  }

  if (body.tx_type !== "contract_call") {
    return { ok: false, code: "WRONG_FUNCTION", reason: "Transaction is not a contract call." };
  }

  const contractId = body.contract_call?.contract_id;
  if (contractId !== expectedContractId) {
    return {
      ok: false,
      code: "WRONG_CONTRACT",
      reason: `Transaction calls ${contractId ?? "unknown"}, not the sBTC token contract.`,
    };
  }

  if (body.contract_call?.function_name !== "transfer") {
    return {
      ok: false,
      code: "WRONG_FUNCTION",
      reason: `Transaction calls ${body.contract_call?.function_name ?? "unknown"}, not transfer.`,
    };
  }

  // Use the actual ft_transfer event so we measure what really moved on-chain,
  // not what the contract call args claimed. tx_status="success" already
  // guarantees post-conditions passed, but events let us pick the matching
  // recipient/asset directly.
  const sbtcAssetId = `${expectedContractId}::sbtc-token`;
  const matchingTransfer = (body.events ?? []).find((evt) => {
    if (evt.event_type !== "fungible_token_asset") return false;
    const a = evt.asset;
    return (
      a?.asset_event_type === "transfer" &&
      a.asset_id === sbtcAssetId &&
      a.recipient === expectedRecipient
    );
  });

  if (!matchingTransfer) {
    // No event to the treasury — could be wrong recipient or wrong asset.
    const anyTransferToRecipient = (body.events ?? []).some(
      (evt) => evt.asset?.asset_event_type === "transfer" && evt.asset?.recipient === expectedRecipient
    );
    if (!anyTransferToRecipient) {
      return {
        ok: false,
        code: "WRONG_RECIPIENT",
        reason: "Transaction did not transfer sBTC to the treasury.",
      };
    }
    return { ok: false, code: "WRONG_ASSET", reason: "Transaction transferred a different asset." };
  }

  const amountStr = matchingTransfer.asset?.amount;
  const amount = amountStr ? Number.parseInt(amountStr, 10) : Number.NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: "MALFORMED_TX", reason: "Transfer event missing a valid amount." };
  }

  if (amount < requiredAmount) {
    return {
      ok: false,
      code: "INSUFFICIENT_AMOUNT",
      reason: `Transferred ${amount} sats, expected at least ${requiredAmount}.`,
    };
  }

  const sender = matchingTransfer.asset?.sender ?? body.sender_address;
  if (!sender) {
    return { ok: false, code: "MALFORMED_TX", reason: "Could not determine sender address from transaction." };
  }

  return {
    ok: true,
    sender,
    amount,
    txid,
    blockHeight: typeof body.block_height === "number" ? body.block_height : null,
  };
}
