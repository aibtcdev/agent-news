/**
 * x402 payment service.
 *
 * Constructs 402 Payment Required responses and verifies payments
 * via the x402 relay service.
 *
 * Payment verification uses the X402_RELAY service binding (RPC) when available,
 * falling back to HTTP for local dev environments where the binding isn't present.
 */

import {
  CheckPaymentRpcResponseSchema,
  SubmitPaymentRpcResponseSchema,
} from "@aibtc/tx-schemas/rpc";
import {
  PaymentStatusHttpResponseSchema,
} from "@aibtc/tx-schemas/http";
import type { PaymentTerminalReason, PaymentTrackedState } from "../lib/types";
import {
  TREASURY_STX_ADDRESS,
  SBTC_CONTRACT_MAINNET,
  X402_RELAY_URL,
  RPC_POLL_MAX_ATTEMPTS,
  RPC_POLL_INTERVAL_MS,
  CIRCUIT_BREAKER_THRESHOLD,
  CIRCUIT_BREAKER_RESET_MS,
} from "../lib/constants";
import type { Env, RelayRPC, SettleOptions, SubmitPaymentResult, CheckPaymentResult, PaymentStatusResponse, Logger } from "../lib/types";
import { logPaymentEvent } from "../lib/payment-logging";
import { derivePaymentIdentifier } from "../lib/helpers";

// ── In-memory circuit breaker for relay calls ──
// Prevents cascading failures when the relay is down by fast-failing after
// consecutive errors. Resets on any successful relay interaction.
const circuitBreaker = {
  failures: 0,
  openUntil: 0,
};

const PENDING_STATES = new Set<PaymentTrackedState>(["queued", "broadcasting", "mempool"]);
const TERMINAL_STATES = new Set<PaymentTrackedState>(["confirmed", "failed", "replaced", "not_found"]);
const NONCE_TERMINAL_REASONS = new Set<PaymentTerminalReason>([
  "sender_nonce_stale",
  "sender_nonce_gap",
  "sender_nonce_duplicate",
]);

const RPC_ERROR_TO_TERMINAL_REASON: Partial<Record<string, PaymentTerminalReason>> = {
  INVALID_TRANSACTION: "invalid_transaction",
  NOT_SPONSORED: "not_sponsored",
  SENDER_NONCE_STALE: "sender_nonce_stale",
  SENDER_NONCE_DUPLICATE: "sender_nonce_duplicate",
  SENDER_NONCE_GAP: "sender_nonce_gap",
  BROADCAST_FAILED: "broadcast_failure",
  TX_BROADCAST_ERROR: "broadcast_failure",
  SETTLEMENT_FAILED: "chain_abort",
  INTERNAL_ERROR: "internal_error",
  // Idempotency key conflict: same identifier submitted with a different transaction.
  // Non-retryable client error — the caller must use a new transaction or identifier.
  PAYMENT_IDENTIFIER_CONFLICT: "unknown_payment_identity",
};

function shouldFastFail(): boolean {
  const now = Date.now();

  // If the circuit is already open, fast-fail until the timer expires.
  if (circuitBreaker.openUntil > 0) {
    if (now < circuitBreaker.openUntil) {
      return true;
    }
    // Half-open: timer expired — reset failures so one probe gets through.
    circuitBreaker.failures = 0;
    circuitBreaker.openUntil = 0;
  }

  // Closed→open transition: only set openUntil once when threshold is crossed.
  if (circuitBreaker.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitBreaker.openUntil = now + CIRCUIT_BREAKER_RESET_MS;
    return true;
  }
  return false;
}

function recordRelayFailure(): void {
  circuitBreaker.failures++;
}

function recordRelaySuccess(): void {
  circuitBreaker.failures = 0;
  circuitBreaker.openUntil = 0;
}

export function resetRelayCircuitBreakerForTests(): void {
  circuitBreaker.failures = 0;
  circuitBreaker.openUntil = 0;
}

export interface PaymentRequiredOpts {
  amount: number;
  description: string;
  /** Machine-readable error code to include in the 402 body (e.g. from a failed retry). */
  code?: string;
}

export interface PaymentVerifyResult {
  valid: boolean;
  txid?: string;
  payer?: string;
  checkStatusUrl?: string;
  paymentState?: PaymentTrackedState;
  terminalReason?: PaymentTerminalReason;
  /**
   * True when the failure is a transient relay error (network timeout, 5xx,
   * parse failure) rather than the payment itself being invalid.
   * Callers should return 503 instead of 402 in this case so that a user
   * who already paid does not retry payment unnecessarily.
   */
  relayError?: boolean;
  /** Human-readable reason from the relay when settlement fails (for diagnostics). */
  relayReason?: string;
  /**
   * Machine-readable error code from the relay (e.g. SENDER_NONCE_STALE,
   * SENDER_NONCE_DUPLICATE, NOT_SPONSORED). Only present on RPC path failures.
   * Callers can use this to distinguish nonce conflicts (409) from other rejections.
   */
  errorCode?: string;
  /**
   * Whether the agent should retry the payment after resolving the underlying issue.
   * Propagated from relay SubmitPaymentResult.retryable and CheckPaymentResult.retryable.
   */
  retryable?: boolean;
  /**
   * "pending" when the RPC poll exhausted before on-chain confirmation arrived.
   * The payment was accepted by the relay and is being processed — valid is still true.
   * Agents should poll the payment-status endpoint using paymentId to confirm settlement.
   * Pending responses without paymentId are treated as relay errors and fail closed.
   */
  paymentStatus?: "pending";
  /**
   * Relay payment identifier (pay_ prefix). Present when paymentStatus is "pending".
   * Use this with the /api/payment-status/:paymentId endpoint to check settlement.
   */
  paymentId?: string;
}

/** Nonce error codes that should produce a 409 response. */
const NONCE_CONFLICT_CODES = new Set([
  "SENDER_NONCE_STALE",
  "SENDER_NONCE_DUPLICATE",
  "SENDER_NONCE_GAP",
  "SPONSOR_NONCE_STALE",
  "SPONSOR_NONCE_DUPLICATE",
  "NONCE_CONFLICT",
]);

/** Nonce gap codes require longer retry — gap resolution needs on-chain confirmation. */
const NONCE_GAP_CODES = new Set(["SENDER_NONCE_GAP"]);

/** Whether the nonce conflict originates from the sender (not the sponsor). */
function isSenderNonceCode(code: string): boolean {
  return code.startsWith("SENDER_NONCE_");
}

function isSenderTerminalReason(reason?: PaymentTerminalReason): boolean {
  return reason !== undefined && NONCE_TERMINAL_REASONS.has(reason);
}

function mapRpcErrorCodeToTerminalReason(code?: string): PaymentTerminalReason | undefined {
  if (!code) {
    return undefined;
  }
  return RPC_ERROR_TO_TERMINAL_REASON[code];
}

function parseSubmitPaymentResult(result: SubmitPaymentResult): SubmitPaymentResult {
  return SubmitPaymentRpcResponseSchema.parse(result);
}

function parseCheckPaymentResult(result: CheckPaymentResult): CheckPaymentResult {
  return CheckPaymentRpcResponseSchema.parse(result);
}

export function buildLocalPaymentStatusUrl(origin: string, paymentId: string): string {
  return `${origin}/api/payment-status/${encodeURIComponent(paymentId)}`;
}

export function buildPaymentStatusResponse(result: CheckPaymentResult): PaymentStatusResponse {
  return PaymentStatusHttpResponseSchema.parse({
    paymentId: result.paymentId,
    status: result.status,
    txid: result.txid,
    blockHeight: result.blockHeight,
    confirmedAt: result.confirmedAt,
    explorerUrl: result.explorerUrl,
    terminalReason: result.terminalReason,
    error: result.error,
    errorCode: result.errorCode,
    retryable: result.retryable,
    checkStatusUrl: result.checkStatusUrl,
  });
}

export interface VerificationErrorBody {
  error: string;
  code?: string;
  retryable: boolean;
  hint?: string;
}

export interface VerificationErrorResult {
  body: VerificationErrorBody;
  status: 402 | 409 | 503;
  headers?: Record<string, string>;
}

/**
 * Map a failed PaymentVerifyResult to an HTTP error response.
 * Returns body, status, and optional headers (e.g. Retry-After on 409).
 * Consolidates nonce-conflict (409), relay-error (503), and payment-invalid (402) logic
 * shared by brief.ts and classifieds.ts.
 */
export function mapVerificationError(
  verification: PaymentVerifyResult
): VerificationErrorResult {
  const code = verification.errorCode;
  const terminalReason = verification.terminalReason ?? mapRpcErrorCodeToTerminalReason(code);
  const isNonceConflict = Boolean((code && NONCE_CONFLICT_CODES.has(code)) || isSenderTerminalReason(terminalReason));
  const isSenderConflict = Boolean(isSenderTerminalReason(terminalReason) || (code && isSenderNonceCode(code)));

  if (isNonceConflict) {
    const side = isSenderConflict ? "sender" : "sponsor";
    const hint = side === "sender"
      ? "Re-fetch your sender nonce and re-sign the transaction before retrying."
      : "Use the recover-nonce tool or check your relay nonce before retrying.";
    const retryAfter = (code && NONCE_GAP_CODES.has(code)) || terminalReason === "sender_nonce_gap"
      ? "30"
      : "5";

    return {
      body: {
        error: `Payment nonce conflict (${side}).`,
        code: code ?? terminalReason,
        retryable: true,
        hint,
      },
      status: 409,
      headers: { "Retry-After": retryAfter },
    };
  }

  if (verification.relayError) {
    return {
      body: {
        error: "Payment relay unavailable. Your payment was not consumed — please retry shortly.",
        code: "RELAY_UNAVAILABLE",
        retryable: true,
      },
      status: 503,
      headers: { "Retry-After": "10" },
    };
  }

  const reason = verification.relayReason
    ? ` Relay: ${verification.relayReason}`
    : "";
  const body: VerificationErrorBody = {
    error: `Payment verification failed.${reason}`,
    retryable: verification.retryable ?? true,
  };
  if (verification.errorCode ?? terminalReason) {
    body.code = verification.errorCode ?? terminalReason;
  }
  return { body, status: 402 as const };
}

/**
 * Build a 402 Payment Required response with x402 payment requirements.
 * Returns a proper 402 response with paymentRequirements JSON body.
 */
export function buildPaymentRequired(opts: PaymentRequiredOpts): Response {
  const { amount, description, code } = opts;

  const paymentRequirements = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "stacks:1",
        amount: String(amount),
        asset: SBTC_CONTRACT_MAINNET,
        payTo: TREASURY_STX_ADDRESS,
        maxTimeoutSeconds: 60,
        description,
      },
    ],
  };

  // btoa() rejects characters above U+00FF, so Unicode descriptions (e.g. em dashes)
  // must be UTF-8 encoded first. The client decodes with Buffer.from(b64, "base64").
  let encoded: string | undefined;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(paymentRequirements));
    encoded = btoa(String.fromCharCode(...bytes));
  } catch {
    // Encoding failure should not crash — body still contains payment details
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (encoded) {
    headers["payment-required"] = encoded;
  }

  const body: Record<string, unknown> = {
    error: "Payment Required",
    message: description,
    payTo: TREASURY_STX_ADDRESS,
    amount,
    asset: SBTC_CONTRACT_MAINNET,
    x402: paymentRequirements,
  };
  if (code) {
    body.code = code;
  }

  return new Response(
    JSON.stringify(body),
    {
      status: 402,
      headers,
    }
  );
}

/**
 * Runtime type guard — verifies the binding exposes submitPayment().
 * Mirrors the isLogsRPC() pattern used for the LOGS binding.
 */
export function isRelayRPC(relay: unknown): relay is RelayRPC {
  return (
    typeof relay === "object" &&
    relay !== null &&
    typeof (relay as Record<string, unknown>).submitPayment === "function" &&
    typeof (relay as Record<string, unknown>).checkPayment === "function"
  );
}

/**
 * Interpret an HTTP /settle response from the relay.
 * Only used by the HTTP fallback path — the RPC path handles results inline.
 */
function interpretHttpRelayResult(result: {
  success?: boolean;
  transaction?: string;
  payer?: string;
  status?: string;
  paymentId?: string;
  checkStatusUrl?: string;
  error?: string;
}): PaymentVerifyResult {
  if (result.success) {
    return {
      valid: true,
      txid: result.transaction,
      payer: result.payer,
      paymentState: "confirmed",
    };
  }

  if (result.status === "pending") {
    if (!result.paymentId) {
      console.error("[x402] relay returned pending without paymentId (http):", JSON.stringify(result));
      return {
        valid: false,
        relayError: true,
        relayReason: "Relay returned pending status without a paymentId",
      };
    }

    return {
      valid: true,
      payer: result.payer,
      paymentState: "queued",
      paymentStatus: "pending",
      paymentId: result.paymentId,
      checkStatusUrl: result.checkStatusUrl,
    };
  }

  console.error("[x402] relay payment rejected (http):", JSON.stringify(result));
  return {
    valid: false,
    relayReason: result.error ?? JSON.stringify(result),
  };
}

/**
 * Verify an x402 payment via the relay service.
 * The paymentHeader is the value of the X-PAYMENT or payment-signature header.
 *
 * When env.X402_RELAY is available (production/staging), uses the Cloudflare
 * service binding RPC path (submitPayment). Falls back to HTTP POST /settle
 * when the binding is absent (local dev).
 *
 * Result semantics:
 *   { valid: true }                    — payment verified, proceed
 *   { valid: false }                   — payment invalid (bad sig, wrong amount, etc.)
 *   { valid: false, relayError: true } — transient relay failure; caller should 503
 */
export async function verifyPayment(
  paymentHeader: string,
  amount: number,
  env?: Env,
  logContext?: { logger?: Logger; route?: string }
): Promise<PaymentVerifyResult> {
  let paymentPayload: Record<string, unknown>;
  try {
    paymentPayload = JSON.parse(atob(paymentHeader)) as Record<string, unknown>;
  } catch {
    // Malformed payment header — client error, not a relay error
    return { valid: false };
  }

  // Fast-fail if the relay circuit breaker is open (consecutive failures).
  // Placed after payload validation so malformed headers still get a proper
  // 402 (client error) instead of being masked as a 503 (relay error).
  if (shouldFastFail()) {
    console.warn("[x402] circuit breaker open — fast-failing relay call");
    return { valid: false, relayError: true, relayReason: "Relay circuit breaker open — too many recent failures" };
  }

  const paymentRequirements = {
    scheme: "exact",
    network: "stacks:1",
    amount: String(amount),
    asset: SBTC_CONTRACT_MAINNET,
    payTo: TREASURY_STX_ADDRESS,
    maxTimeoutSeconds: 60,
  };

  // --- RPC path (service binding available and valid) ---
  if (env?.ENVIRONMENT !== "test" && env?.X402_RELAY && isRelayRPC(env.X402_RELAY)) {
    // Extract the signed transaction hex from the payment payload.
    // The x402 v2 payment payload shape is: { payload: { transaction: "<hex>" }, ... }
    const innerPayload = paymentPayload.payload as Record<string, unknown> | undefined;
    const txHex = typeof innerPayload?.transaction === "string" ? innerPayload.transaction : undefined;
    if (!txHex) {
      // Malformed payment payload — client error, not a relay error
      console.error("[x402] RPC path: missing payload.transaction in payment header");
      return { valid: false };
    }

    // Build SettleOptions from the payment requirements for this request.
    const settle: SettleOptions = {
      expectedRecipient: paymentRequirements.payTo,
      minAmount: paymentRequirements.amount,
    };

    // Derive a deterministic idempotency key from the transaction hex.
    // Same tx resubmitted on retry → same identifier → relay returns cached paymentId.
    const paymentIdentifier = await derivePaymentIdentifier(txHex);

    // Step 1: Submit the payment to the relay queue.
    let submitResult: SubmitPaymentResult;
    try {
      console.log("[x402] using RPC path via X402_RELAY service binding");
      submitResult = parseSubmitPaymentResult(await env.X402_RELAY.submitPayment(txHex, settle, paymentIdentifier));
    } catch (err) {
      // RPC call failure is a relay error — do not penalise the payer
      console.error("[x402] RPC submitPayment threw:", err);
      recordRelayFailure();
      return { valid: false, relayError: true };
    }

    if (!submitResult.accepted) {
      console.error("[x402] RPC submitPayment rejected:", submitResult.code, submitResult.error);
      return {
        valid: false,
        relayReason: submitResult.error ?? submitResult.code ?? "Payment rejected by relay",
        errorCode: submitResult.code,
        terminalReason: mapRpcErrorCodeToTerminalReason(submitResult.code),
        retryable: submitResult.retryable,
      };
    }

    const paymentId = submitResult.paymentId;
    const checkStatusUrl = submitResult.checkStatusUrl;
    if (!paymentId) {
      console.error("[x402] RPC submitPayment accepted but did not return a paymentId");
      return {
        valid: false,
        relayError: true,
        relayReason: "Relay accepted payment but did not return a paymentId",
      };
    }
    console.log("[x402] RPC payment queued:", paymentId, submitResult.status);

    // Step 2: Poll checkPayment() until confirmed, failed, or timeout.
    let lastCheckResult: CheckPaymentResult | undefined;
    for (let attempt = 0; attempt < RPC_POLL_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, RPC_POLL_INTERVAL_MS));
      }

      let checkResult: CheckPaymentResult;
      let rawCheckResult: CheckPaymentResult;
      try {
        rawCheckResult = await env.X402_RELAY.checkPayment(paymentId);
      } catch (err) {
        console.error("[x402] RPC checkPayment transport failure:", err);
        // Treat as transient relay error — payer should not be penalised
        recordRelayFailure();
        return {
          valid: false,
          relayError: true,
          relayReason: "Failed to reach payment relay during payment status poll",
        };
      }

      try {
        checkResult = parseCheckPaymentResult(rawCheckResult);
      } catch (err) {
        console.error("[x402] RPC checkPayment returned invalid payload:", err);
        recordRelayFailure();
        return {
          valid: false,
          relayError: true,
          relayReason: "Relay returned an invalid payment status payload",
        };
      }

      lastCheckResult = checkResult;
      console.log(`[x402] RPC checkPayment attempt ${attempt + 1}:`, checkResult.status);

      if (checkResult.status === "confirmed") {
        recordRelaySuccess();
        return {
          valid: true,
          txid: checkResult.txid,
          paymentId,
          checkStatusUrl: checkResult.checkStatusUrl ?? checkStatusUrl,
          paymentState: "confirmed",
        };
      }

      if (checkResult.status === "failed" || checkResult.status === "replaced" || checkResult.status === "not_found") {
        // Payment-level failure, not a relay error — relay responded correctly.
        // Do NOT record as relay failure; the circuit breaker should not trip
        // on legitimate payment rejections (insufficient fee, RBF replaced, etc.).
        return {
          valid: false,
          relayReason: checkResult.error ?? `Payment ${checkResult.status}`,
          errorCode: checkResult.errorCode,
          paymentId,
          checkStatusUrl: checkResult.checkStatusUrl ?? checkStatusUrl,
          paymentState: checkResult.status,
          terminalReason: checkResult.terminalReason,
          retryable: checkResult.retryable,
        };
      }

      // status is "queued", "broadcasting", "mempool" — keep polling
    }

    // Poll exhausted — decide based on last known status.
    if (lastCheckResult && PENDING_STATES.has(lastCheckResult.status)) {
      // Payment was accepted by relay and is still processing a known pending status.
      // Return valid=true with paymentStatus="pending" so the caller can stage
      // work locally and poll by paymentId until the relay reaches a terminal state.
      console.warn("[x402] RPC poll exhausted — payment still pending, paymentId:", paymentId);
      recordRelaySuccess();
      return {
        valid: true,
        paymentState: lastCheckResult.status,
        paymentStatus: "pending",
        paymentId,
        checkStatusUrl: lastCheckResult.checkStatusUrl ?? checkStatusUrl,
      };
    }

    if (!lastCheckResult) {
      // We never got a successful checkPayment response (all attempts may have
      // been skipped or the loop ran zero times). Treat as pending — the relay
      // accepted the payment via submitPayment so it is likely still processing.
      console.warn("[x402] RPC poll exhausted — no check response received, paymentId:", paymentId);
      recordRelaySuccess();
      return {
        valid: true,
        paymentState: "queued",
        paymentStatus: "pending",
        paymentId,
        checkStatusUrl,
      };
    }

    if (lastCheckResult && TERMINAL_STATES.has(lastCheckResult.status)) {
      return {
        valid: lastCheckResult.status === "confirmed",
        txid: lastCheckResult.txid,
        paymentId,
        checkStatusUrl: lastCheckResult.checkStatusUrl ?? checkStatusUrl,
        paymentState: lastCheckResult.status,
        terminalReason: lastCheckResult.terminalReason,
        relayReason: lastCheckResult.error ?? `Payment ${lastCheckResult.status}`,
        errorCode: lastCheckResult.errorCode,
        retryable: lastCheckResult.retryable,
      };
    }

    // Safety net: poll exhausted with an unexpected status we don't recognise.
    // This should not happen in normal operation but guards against future relay
    // status values that this code does not yet handle.
    console.warn("[x402] RPC poll exhausted with unexpected status:", lastCheckResult.status, "paymentId:", paymentId);
    return {
      valid: false,
      relayError: true,
      relayReason: `Poll exhausted with unexpected status: ${lastCheckResult.status}`,
    };
  }

  // --- HTTP fallback (local dev / binding not configured) ---
  console.log("[x402] X402_RELAY not bound, falling back to HTTP");
  if (logContext?.logger && logContext.route) {
    logPaymentEvent(logContext.logger, "warn", "payment.fallback_used", {
      route: logContext.route,
      action: "http_settle_fallback",
    });
  }

  let settleRes: Response;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);

    try {
      settleRes = await fetch(`${X402_RELAY_URL}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload,
          paymentRequirements,
        }),
      });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    // Network error or timeout — relay unreachable, not a payment problem
    recordRelayFailure();
    return { valid: false, relayError: true };
  }

  // 5xx from relay = relay-side problem, not an invalid payment
  if (settleRes.status >= 500) {
    recordRelayFailure();
    return { valid: false, relayError: true };
  }

  let result: Record<string, unknown>;
  try {
    result = (await settleRes.json()) as Record<string, unknown>;
  } catch {
    // Unexpected non-JSON body from relay = relay error
    recordRelayFailure();
    return { valid: false, relayError: true };
  }

  // Relay returned a parseable response — reset circuit breaker.
  recordRelaySuccess();

  // Relay returns 200 for both success and failure — check the success field.
  // 4xx = schema/idempotency error; 2xx + !success = payment rejected by relay.
  // Both are payment-invalid, not transient relay errors (5xx handled above).
  return interpretHttpRelayResult({
    success: Boolean(result.success),
    transaction: result.transaction as string | undefined,
    payer: result.payer as string | undefined,
    status: result.status as string | undefined,
    paymentId: result.paymentId as string | undefined,
    checkStatusUrl: result.checkStatusUrl as string | undefined,
    error: (result.error as string) ?? (result.message as string),
  });
}
