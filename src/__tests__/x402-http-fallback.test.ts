import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../lib/types";
import { verifyPayment } from "../services/x402";

function makePaymentHeader(txHex = "deadbeefdeadbeef"): string {
  return btoa(JSON.stringify({ payload: { transaction: txHex }, x402Version: 2 }));
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe("verifyPayment — HTTP fallback", () => {
  it("fails closed when the relay returns pending without paymentId", async () => {
    globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        success: false,
        status: "pending",
        payer: "SP2C2QH2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await verifyPayment(makePaymentHeader(), 100, { ENVIRONMENT: "test" } as Env);

    expect(result.valid).toBe(false);
    expect(result.relayError).toBe(true);
    expect(result.paymentStatus).toBeUndefined();
    expect(result.paymentId).toBeUndefined();
    expect(result.relayReason).toContain("paymentId");
  });

  it("preserves pending staging semantics when paymentId is present", async () => {
    globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        success: false,
        status: "pending",
        paymentId: "pay_http_pending",
        payer: "SP2C2QH2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2",
        checkStatusUrl: "https://relay.example.com/api/payment-status/pay_http_pending",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await verifyPayment(makePaymentHeader(), 100, { ENVIRONMENT: "test" } as Env);

    expect(result.valid).toBe(true);
    expect(result.paymentStatus).toBe("pending");
    expect(result.paymentId).toBe("pay_http_pending");
    expect(result.checkStatusUrl).toBe("https://relay.example.com/api/payment-status/pay_http_pending");
  });
});
