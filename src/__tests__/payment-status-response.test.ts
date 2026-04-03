import { describe, expect, it } from "vitest";
import { buildPaymentStatusResponse } from "../services/x402";

describe("buildPaymentStatusResponse", () => {
  it("preserves canonical terminal status and terminalReason", () => {
    const body = buildPaymentStatusResponse({
      paymentId: "pay_failed",
      status: "failed",
      terminalReason: "sender_nonce_stale",
      error: "nonce stale",
      retryable: true,
      checkStatusUrl: "https://relay.example.com/api/payment-status/pay_failed",
    });

    expect(body.status).toBe("failed");
    expect(body.terminalReason).toBe("sender_nonce_stale");
    expect(body.paymentId).toBe("pay_failed");
    expect(body.checkStatusUrl).toBe("https://relay.example.com/api/payment-status/pay_failed");
  });

  it("keeps mempool as a pending status without terminalReason", () => {
    const body = buildPaymentStatusResponse({
      paymentId: "pay_mempool",
      status: "mempool",
      txid: "a".repeat(64),
    });

    expect(body.status).toBe("mempool");
    expect(body.terminalReason).toBeUndefined();
    expect(body.paymentId).toBe("pay_mempool");
  });
});
