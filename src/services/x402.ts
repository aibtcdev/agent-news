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
} from "../lib/constants";
import type { Env, RelayRPC } from "../lib/types";

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
 * Interpret a relay result (shared by both RPC and HTTP paths).
 * Returns a PaymentVerifyResult based on the success/status/error fields.
 */
/**
 * Runtime type guard — verifies the binding exposes submitPayment().
 * Mirrors the isLogsRPC() pattern used for the LOGS binding.
 */
function isRelayRPC(relay: unknown): relay is RelayRPC {
  return (
    typeof relay === "object" &&
    relay !== null &&
    typeof (relay as Record<string, unknown>).submitPayment === "function"
  );
}

function interpretRelayResult(
  result: {
    success?: boolean;
    accepted?: boolean;
    transaction?: string;
    paymentId?: string;
    payer?: string;
    status?: string;
    error?: string;
  },
  path: "rpc" | "http"
): PaymentVerifyResult {
  // Normalise: RPC may return { accepted, paymentId } or legacy { success, transaction }
  const isValid =
    result.success || result.accepted || result.status === "pending";

  if (isValid) {
    return {
      valid: true,
      txid: result.transaction ?? result.paymentId,
      payer: result.payer,
    };
  }

  console.error(`[x402] relay payment rejected (${path}):`, JSON.stringify(result));
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
    let result: Awaited<ReturnType<RelayRPC["submitPayment"]>>;
    try {
      console.log("[x402] using RPC path via X402_RELAY service binding");
      result = await env.X402_RELAY.submitPayment(paymentPayload, paymentRequirements);
    } catch (err) {
      // RPC call failure is a relay error — do not penalise the payer
      console.error("[x402] RPC submitPayment threw:", err);
      return { valid: false, relayError: true };
    }
    return interpretRelayResult(result, "rpc");
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
  return interpretRelayResult({
    success: Boolean(result.success),
    transaction: result.transaction as string | undefined,
    payer: result.payer as string | undefined,
    status: result.status as string | undefined,
    error: (result.error as string) ?? (result.message as string),
  }, "http");
}
