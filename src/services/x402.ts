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
        network: "stacks:mainnet",
        amount: String(amount),
        asset: SBTC_CONTRACT_MAINNET,
        payTo: TREASURY_STX_ADDRESS,
        description,
      },
    ],
  };

  const encoded = btoa(JSON.stringify(paymentRequirements));

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
      headers: {
        "Content-Type": "application/json",
        "payment-required": encoded,
      },
    }
  );
}

/**
 * Verify an x402 payment via the relay's /settle endpoint.
 * The paymentHeader is the value of the X-PAYMENT or payment-signature header.
 */
export async function verifyPayment(
  paymentHeader: string,
  amount: number
): Promise<PaymentVerifyResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    let settleRes: Response;
    try {
      settleRes = await fetch(`${X402_RELAY_URL}/api/v1/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          paymentSignature: paymentHeader,
          paymentRequirements: {
            scheme: "exact",
            network: "stacks:mainnet",
            amount: String(amount),
            asset: SBTC_CONTRACT_MAINNET,
            payTo: TREASURY_STX_ADDRESS,
          },
        }),
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const result = (await settleRes.json()) as Record<string, unknown>;

    if (!settleRes.ok || !result.success) {
      return { valid: false };
    }

    // Decode payment header for payer info
    let paymentData: Record<string, unknown> = {};
    try {
      paymentData = JSON.parse(atob(paymentHeader)) as Record<string, unknown>;
    } catch {
      // ignore decode errors
    }

    return {
      valid: true,
      txid: (result.txid as string | undefined) || (paymentData.txid as string | undefined),
      payer:
        (result.payer as string | undefined) ||
        (paymentData.btcAddress as string | undefined) ||
        (paymentData.from as string | undefined),
    };
  } catch {
    return { valid: false };
  }
}
