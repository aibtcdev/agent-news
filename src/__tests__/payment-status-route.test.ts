import { afterEach, describe, expect, it, vi } from "vitest";
import { SELF, env } from "cloudflare:test";

const testEnv = env as typeof env & {
  X402_RELAY?: {
    submitPayment: ReturnType<typeof vi.fn>;
    checkPayment: ReturnType<typeof vi.fn>;
  };
  NEWS_DO?: DurableObjectNamespace;
};

const originalNewsDo = testEnv.NEWS_DO;

afterEach(() => {
  vi.restoreAllMocks();
  testEnv.NEWS_DO = originalNewsDo;
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

  it("finalizes a confirmed staged record exactly once through the polling route", async () => {
    const paymentId = "pay_route_confirmed_001";
    const classifiedId = "cl-route-confirmed-001";

    const stageRes = await SELF.fetch("http://example.com/api/test/payment-stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentId,
        payload: {
          kind: "classified_submission",
          classified_id: classifiedId,
          btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
          category: "services",
          headline: "Finalize via /api/payment-status",
          body: "Pending until confirmed",
          payment_txid: null,
        },
      }),
    });
    expect(stageRes.status).toBe(201);

    testEnv.X402_RELAY = {
      submitPayment: vi.fn(),
      checkPayment: vi.fn().mockResolvedValue({
        paymentId,
        status: "confirmed",
        txid: "a".repeat(64),
      }),
    };

    const firstPoll = await SELF.fetch(`http://example.com/api/payment-status/${paymentId}`);
    expect(firstPoll.status).toBe(200);
    const firstBody = await firstPoll.json<{ status: string }>();
    expect(firstBody.status).toBe("confirmed");

    const finalizedRes = await SELF.fetch(`http://example.com/api/classifieds/${classifiedId}`);
    expect(finalizedRes.status).toBe(200);

    const stageStateAfterFirstPoll = await SELF.fetch(`http://example.com/api/test/payment-stage/${paymentId}`);
    expect(stageStateAfterFirstPoll.status).toBe(200);
    const firstStageBody = await stageStateAfterFirstPoll.json<{ data: { stageStatus: string; finalizedAt: string | null } }>();
    expect(firstStageBody.data.stageStatus).toBe("finalized");
    expect(firstStageBody.data.finalizedAt).not.toBeNull();

    const secondPoll = await SELF.fetch(`http://example.com/api/payment-status/${paymentId}`);
    expect(secondPoll.status).toBe(200);

    const stageStateAfterSecondPoll = await SELF.fetch(`http://example.com/api/test/payment-stage/${paymentId}`);
    const secondStageBody = await stageStateAfterSecondPoll.json<{ data: { stageStatus: string; finalizedAt: string | null } }>();
    expect(secondStageBody.data.stageStatus).toBe("finalized");
    expect(secondStageBody.data.finalizedAt).toBe(firstStageBody.data.finalizedAt);
  });

  it("returns 503 when payment is terminal but staged delivery reconciliation fails", async () => {
    const paymentId = "pay_route_confirmed_reconcile_fail";

    testEnv.X402_RELAY = {
      submitPayment: vi.fn(),
      checkPayment: vi.fn().mockResolvedValue({
        paymentId,
        status: "confirmed",
        txid: "b".repeat(64),
      }),
    };

    testEnv.NEWS_DO = {
      idFromName: vi.fn().mockReturnValue({}),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ ok: false, error: "DO unavailable" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          })
        ),
      }),
    } as unknown as DurableObjectNamespace;

    const res = await SELF.fetch(`http://example.com/api/payment-status/${paymentId}`);

    expect(res.status).toBe(503);
    const body = await res.json<{ status: string; error: string; warning: string }>();
    expect(body.status).toBe("confirmed");
    expect(body.error).toContain("delivery reconciliation is still pending");
    expect(body.warning).toContain("not been finalized");
  });
});
