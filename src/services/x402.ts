/**
 * x402 payment service.
 *
 * Constructs 402 Payment Required responses and verifies payments
 * via the x402 relay service.
 */

import {
  TREASURY_STX_ADDRESS,
  SBTC_CONTRACT_MAINNET,
  X402_RELAY_URL,
} from "../lib/constants";

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
 * Verify an x402 payment via the relay's /settle endpoint.
 * The paymentHeader is the value of the X-PAYMENT or payment-signature header.
 *
 * Result semantics:
 *   { valid: true }                    — payment verified, proceed
 *   { valid: false }                   — payment invalid (bad sig, wrong amount, etc.)
 *   { valid: false, relayError: true } — transient relay failure; caller should 503
 */
export async function verifyPayment(
  paymentHeader: string,
  amount: number
): Promise<PaymentVerifyResult> {
  let paymentPayload: Record<string, unknown>;
  try {
    paymentPayload = JSON.parse(atob(paymentHeader)) as Record<string, unknown>;
  } catch {
    // Malformed payment header — client error, not a relay error
    return { valid: false };
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
          paymentRequirements: {
            scheme: "exact",
            network: "stacks:1",
            amount: String(amount),
            asset: SBTC_CONTRACT_MAINNET,
            payTo: TREASURY_STX_ADDRESS,
            maxTimeoutSeconds: 60,
          },
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
  if (!result.success) {
    // Treat "pending" status as valid — the tx was broadcast successfully and
    // confirmation is async.  The relay just hasn't seen it confirm yet.
    if (result.status === "pending") {
      return {
        valid: true,
        txid: result.transaction as string | undefined,
        payer: result.payer as string | undefined,
      };
    }

    console.error("[x402] relay settle rejected:", JSON.stringify(result));
    return {
      valid: false,
      relayReason: (result.error as string) ?? (result.message as string) ?? JSON.stringify(result),
    };
  }

  return {
    valid: true,
    txid: result.transaction as string | undefined,
    payer: result.payer as string | undefined,
  };
}
