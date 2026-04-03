import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

const BTC_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

describe("payment staging", () => {
  it("keeps staged records provisional when reconciliation sees mempool", async () => {
    const stageRes = await SELF.fetch("http://example.com/api/test/payment-stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentId: "pay_stage_mempool",
        payload: {
          kind: "classified_submission",
          classified_id: "cl-stage-mempool",
          btc_address: BTC_ADDRESS,
          category: "services",
          headline: "Mempool classified",
          body: "Still pending",
          payment_txid: null,
        },
      }),
    });
    expect(stageRes.status).toBe(201);

    const reconcileRes = await SELF.fetch("http://example.com/api/test/payment-stage/pay_stage_mempool/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "mempool", txid: "b".repeat(64) }),
    });
    expect(reconcileRes.status).toBe(200);
    const reconcileBody = await reconcileRes.json<{ data: { stageStatus: string; terminalStatus: string | null } }>();
    expect(reconcileBody.data.stageStatus).toBe("staged");
    expect(reconcileBody.data.terminalStatus).toBeNull();

    const staged = await SELF.fetch("http://example.com/api/classifieds/cl-stage-mempool");
    expect(staged.status).toBe(404);
  });

  it("preserves paymentId-owned staged classified records until confirmed", async () => {
    const stageRes = await SELF.fetch("http://example.com/api/test/payment-stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentId: "pay_stage_classified",
        payload: {
          kind: "classified_submission",
          classified_id: "cl-stage-001",
          btc_address: BTC_ADDRESS,
          category: "services",
          headline: "Staged classified",
          body: "Pending settlement",
          payment_txid: null,
        },
      }),
    });
    expect(stageRes.status).toBe(201);

    const beforeConfirm = await SELF.fetch("http://example.com/api/classifieds/cl-stage-001");
    expect(beforeConfirm.status).toBe(404);

    const confirmRes = await SELF.fetch("http://example.com/api/test/payment-stage/pay_stage_classified/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "confirmed", txid: "a".repeat(64) }),
    });
    expect(confirmRes.status).toBe(200);
    const confirmBody = await confirmRes.json<{ data: { stageStatus: string } }>();
    expect(confirmBody.data.stageStatus).toBe("finalized");

    const finalized = await SELF.fetch("http://example.com/api/classifieds/cl-stage-001");
    expect(finalized.status).toBe(200);

    const secondConfirm = await SELF.fetch("http://example.com/api/test/payment-stage/pay_stage_classified/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "confirmed", txid: "a".repeat(64) }),
    });
    const secondBody = await secondConfirm.json<{ data: { stageStatus: string } }>();
    expect(secondBody.data.stageStatus).toBe("finalized");
  });

  it("discards staged records on terminal non-success outcomes", async () => {
    const cases = [
      {
        paymentId: "pay_stage_failed",
        status: "failed",
        terminalReason: "sender_nonce_stale",
      },
      {
        paymentId: "pay_stage_replaced",
        status: "replaced",
        terminalReason: "superseded",
      },
      {
        paymentId: "pay_stage_not_found",
        status: "not_found",
        terminalReason: "expired",
      },
    ] as const;

    for (const testCase of cases) {
      const stageRes = await SELF.fetch("http://example.com/api/test/payment-stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId: testCase.paymentId,
          payload: {
            kind: "brief_access",
            date: "2026-04-01",
            payer: null,
            amount_sats: 42,
          },
        }),
      });
      expect(stageRes.status).toBe(201);

      const discardRes = await SELF.fetch(`http://example.com/api/test/payment-stage/${testCase.paymentId}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: testCase.status, terminalReason: testCase.terminalReason }),
      });
      expect(discardRes.status).toBe(200);

      const stageState = await SELF.fetch(`http://example.com/api/test/payment-stage/${testCase.paymentId}`);
      expect(stageState.status).toBe(200);
      const stageBody = await stageState.json<{ data: { stageStatus: string; terminalStatus: string; terminalReason: string } }>();
      expect(stageBody.data.stageStatus).toBe("discarded");
      expect(stageBody.data.terminalStatus).toBe(testCase.status);
      expect(stageBody.data.terminalReason).toBe(testCase.terminalReason);
    }
  });

  it("reuses the existing staged payload for duplicate paymentId submissions", async () => {
    await SELF.fetch("http://example.com/api/test/payment-stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentId: "pay_duplicate_stage",
        payload: {
          kind: "classified_submission",
          classified_id: "cl-dup-001",
          btc_address: BTC_ADDRESS,
          category: "services",
          headline: "Original headline",
          body: null,
          payment_txid: null,
        },
      }),
    });

    const duplicateRes = await SELF.fetch("http://example.com/api/test/payment-stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentId: "pay_duplicate_stage",
        payload: {
          kind: "classified_submission",
          classified_id: "cl-dup-002",
          btc_address: BTC_ADDRESS,
          category: "wanted",
          headline: "Duplicate headline should not win",
          body: null,
          payment_txid: null,
        },
      }),
    });
    expect(duplicateRes.status).toBe(200);
    const duplicateBody = await duplicateRes.json<{ data: { payload: { classified_id: string; headline: string } } }>();
    expect(duplicateBody.data.payload.classified_id).toBe("cl-dup-001");
    expect(duplicateBody.data.payload.headline).toBe("Original headline");
  });

  it("rejects unsupported staged payload kinds", async () => {
    const res = await SELF.fetch("http://example.com/api/test/payment-stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentId: "pay_invalid_stage_kind",
        payload: {
          kind: "unknown_kind",
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("Unsupported payment stage kind");
  });
});
