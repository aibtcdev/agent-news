import { afterEach, describe, expect, it, vi } from "vitest";
import { SELF, env } from "cloudflare:test";

const testEnv = env as typeof env & {
  X402_RELAY?: {
    submitPayment: ReturnType<typeof vi.fn>;
    checkPayment: ReturnType<typeof vi.fn>;
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/payment-status/:paymentId", () => {
  it("mirrors canonical relay fields without exposing internal-only states", async () => {
    const paymentId = "pay_route_failed_001";
    const checkStatusUrl = `https://relay.example.com/api/payment-status/${paymentId}`;

    testEnv.X402_RELAY = {
      submitPayment: vi.fn(),
      checkPayment: vi.fn().mockResolvedValue({
        paymentId,
        status: "failed",
        terminalReason: "sender_nonce_stale",
        error: "nonce stale",
        retryable: true,
        checkStatusUrl,
      }),
    };

    const res = await SELF.fetch(`http://example.com/api/payment-status/${paymentId}`);

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      paymentId,
      status: "failed",
      terminalReason: "sender_nonce_stale",
      error: "nonce stale",
      retryable: true,
      checkStatusUrl,
    });
    expect(body.submitted).toBeUndefined();
  });
});
