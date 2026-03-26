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
  TREASURY_STX_ADDRESS,
  SBTC_CONTRACT_MAINNET,
  X402_RELAY_URL,
  RPC_POLL_MAX_ATTEMPTS,
  RPC_POLL_INTERVAL_MS,
} from "../lib/constants";
import type { Env, RelayRPC, SettleOptions, SubmitPaymentResult, CheckPaymentResult } from "../lib/types";

export interface PaymentRequiredOpts {
  amount: number;
  description: string;
}

export interface PaymentVerifyResult {
  valid: boolean;
  txid?: string;
  payer?: string;
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
}

/**
 * Map a failed PaymentVerifyResult to an HTTP error response.
 * Returns [body, statusCode] for the caller to pass to c.json().
 * Consolidates nonce-conflict (409), relay-error (503), and payment-invalid (402) logic
 * shared by brief.ts and classifieds.ts.
 */
export function mapVerificationError(
  verification: PaymentVerifyResult
): [body: Record<string, unknown>, status: 402 | 409 | 503] {
  if (
    verification.errorCode === "SENDER_NONCE_STALE" ||
    verification.errorCode === "SENDER_NONCE_DUPLICATE"
  ) {
    return [
      {
        error: "Payment nonce conflict. Recover your sponsor nonce and retry.",
        errorCode: verification.errorCode,
        retryable: true,
        hint: "Use the recover-nonce tool or check your relay nonce before retrying.",
      },
      409,
    ];
  }

  if (verification.relayError) {
    return [
      {
        error: "Payment relay unavailable. Your payment was not consumed — please retry shortly.",
        retryable: true,
      },
      503,
    ];
  }

  const reason = verification.relayReason
    ? ` Relay: ${verification.relayReason}`
    : "";
  return [
    {
      error: `Payment verification failed.${reason}`,
      retryable: verification.retryable ?? true,
    },
    402,
  ];
}

/**
 * Build a 402 Payment Required response with x402 payment requirements.
 * Returns a proper 402 response with paymentRequirements JSON body.
 */
export function buildPaymentRequired(opts: PaymentRequiredOpts): Response {
  const { amount, description } = opts;

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

  return new Response(
    JSON.stringify({
      error: "Payment Required",
      message: description,
      payTo: TREASURY_STX_ADDRESS,
      amount,
      asset: SBTC_CONTRACT_MAINNET,
      x402: paymentRequirements,
    }),
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
function isRelayRPC(relay: unknown): relay is RelayRPC {
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
  error?: string;
}): PaymentVerifyResult {
  if (result.success || result.status === "pending") {
    return {
      valid: true,
      txid: result.transaction,
      payer: result.payer,
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
  env?: Env
): Promise<PaymentVerifyResult> {
  let paymentPayload: Record<string, unknown>;
  try {
    paymentPayload = JSON.parse(atob(paymentHeader)) as Record<string, unknown>;
  } catch {
    // Malformed payment header — client error, not a relay error
    return { valid: false };
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
  if (env?.X402_RELAY && isRelayRPC(env.X402_RELAY)) {
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

    // Step 1: Submit the payment to the relay queue.
    let submitResult: SubmitPaymentResult;
    try {
      console.log("[x402] using RPC path via X402_RELAY service binding");
      submitResult = await env.X402_RELAY.submitPayment(txHex, settle);
    } catch (err) {
      // RPC call failure is a relay error — do not penalise the payer
      console.error("[x402] RPC submitPayment threw:", err);
      return { valid: false, relayError: true };
    }

    if (!submitResult.accepted) {
      console.error("[x402] RPC submitPayment rejected:", submitResult.code, submitResult.error);
      return {
        valid: false,
        relayReason: submitResult.error ?? submitResult.code ?? "Payment rejected by relay",
        errorCode: submitResult.code,
        retryable: submitResult.retryable,
      };
    }

    const paymentId = submitResult.paymentId;
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
    for (let attempt = 0; attempt < RPC_POLL_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, RPC_POLL_INTERVAL_MS));
      }

      let checkResult: CheckPaymentResult;
      try {
        checkResult = await env.X402_RELAY.checkPayment(paymentId);
      } catch (err) {
        console.error("[x402] RPC checkPayment threw:", err);
        // Treat as transient relay error — payer should not be penalised
        return { valid: false, relayError: true };
      }

      console.log(`[x402] RPC checkPayment attempt ${attempt + 1}:`, checkResult.status);

      if (checkResult.status === "confirmed") {
        return { valid: true, txid: checkResult.txid };
      }

      if (checkResult.status === "failed" || checkResult.status === "replaced") {
        return {
          valid: false,
          relayReason: checkResult.error ?? `Payment ${checkResult.status}`,
          errorCode: checkResult.errorCode,
          retryable: checkResult.retryable,
        };
      }

      if (checkResult.status === "not_found") {
        return {
          valid: false,
          relayReason: "Payment not found in relay — it may have expired",
          retryable: true,
        };
      }

      // status is "queued", "submitted", "broadcasting", "mempool" — keep polling
    }

    // Exhausted all poll attempts — treat as transient so the payer is not charged again
    console.error("[x402] RPC poll timed out waiting for settlement, paymentId:", paymentId);
    return {
      valid: false,
      relayError: true,
      relayReason: "RPC poll timed out waiting for settlement",
    };
  }

  // --- HTTP fallback (local dev / binding not configured) ---
  console.log("[x402] X402_RELAY not bound, falling back to HTTP");

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
    return { valid: false, relayError: true };
  }

  // 5xx from relay = relay-side problem, not an invalid payment
  if (settleRes.status >= 500) {
    return { valid: false, relayError: true };
  }

  let result: Record<string, unknown>;
  try {
    result = (await settleRes.json()) as Record<string, unknown>;
  } catch {
    // Unexpected non-JSON body from relay = relay error
    return { valid: false, relayError: true };
  }

  // Relay returns 200 for both success and failure — check the success field.
  // 4xx = schema/idempotency error; 2xx + !success = payment rejected by relay.
  // Both are payment-invalid, not transient relay errors (5xx handled above).
  return interpretHttpRelayResult({
    success: Boolean(result.success),
    transaction: result.transaction as string | undefined,
    payer: result.payer as string | undefined,
    status: result.status as string | undefined,
    error: (result.error as string) ?? (result.message as string),
  });
}
