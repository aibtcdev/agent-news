import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import {
  FIXTURE_BTC_ADDRESS as BTC_ADDRESS,
  reconcileStage,
  seedPendingSignal,
  stageSignalSubmission,
} from "./_payment-fixtures";

/**
 * Coverage for the visibility / counts / finalize behaviour of x402-paid signal
 * submissions. The full HTTP path through POST /api/signals (verifyPayment +
 * identity gate + BIP-322 auth) is exercised by the staging-preview smoke test;
 * these tests pin the registry contract that any regression would touch.
 */

describe("signal x402 visibility + finalize flow", () => {
  it("hides pending_payment from default GET /api/signals listings", async () => {
    const id = "sig-visibility-default-001";
    await seedPendingSignal(id);

    const res = await SELF.fetch(`http://example.com/api/signals?agent=${BTC_ADDRESS}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ signals: Array<{ id: string }> }>();
    expect(body.signals.find((s) => s.id === id)).toBeUndefined();
  });

  it("rejects ?include_pending=true without an agent filter (400)", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals?include_pending=true"
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("PENDING_REQUIRES_AGENT");
  });

  it("rejects ?status=pending_payment without BIP-322 auth (401)", async () => {
    const res = await SELF.fetch(
      `http://example.com/api/signals?agent=${BTC_ADDRESS}&status=pending_payment`
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("MISSING_AUTH");
  });

  it("hides x402-staged signals from the public per-id endpoint (404)", async () => {
    const id = "sig-visibility-per-id-hidden-001";
    await seedPendingSignal(id);

    const res = await SELF.fetch(`http://example.com/api/signals/${id}`);
    expect(res.status).toBe(404);
  });

  it("excludes pending_payment from /api/signals/counts by default", async () => {
    await seedPendingSignal("sig-counts-exclude-001");

    const res = await SELF.fetch("http://example.com/api/signals/counts");
    expect(res.status).toBe(200);
    const body = await res.json<{ pending_payment?: number }>();
    expect(body.pending_payment).toBeUndefined();
  });

  it("rejects /api/signals/counts?include_pending=true without ?agent= (400)", async () => {
    const res = await SELF.fetch("http://example.com/api/signals/counts?include_pending=true");
    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("PENDING_REQUIRES_AGENT");
  });

  it("rejects /api/signals/counts?include_pending=true without auth (401)", async () => {
    const res = await SELF.fetch(
      `http://example.com/api/signals/counts?agent=${BTC_ADDRESS}&include_pending=true`
    );
    expect(res.status).toBe(401);
  });

  it("serves agent-scoped /api/signals/counts unauthenticated (no pending bucket)", async () => {
    const isolatedAddr = "bc1qpending0counts0agent000000000000000000";
    await seedPendingSignal("sig-counts-include-agent-001", { btcAddress: isolatedAddr });

    const res = await SELF.fetch(`http://example.com/api/signals/counts?agent=${isolatedAddr}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ pending_payment?: number }>();
    expect(body.pending_payment).toBeUndefined();
  });

  it("flips a finalised signal into the default listing after a confirmed reconcile", async () => {
    const signalId = "sig-flow-finalise-001";
    await seedPendingSignal(signalId);
    await stageSignalSubmission("pay_signal_flow_finalize", signalId);

    const beforeRes = await SELF.fetch(`http://example.com/api/signals?agent=${BTC_ADDRESS}`);
    const beforeBody = await beforeRes.json<{ signals: Array<{ id: string }> }>();
    expect(beforeBody.signals.find((s) => s.id === signalId)).toBeUndefined();

    await reconcileStage("pay_signal_flow_finalize", "confirmed", { txid: "a".repeat(64) });

    const afterRes = await SELF.fetch(`http://example.com/api/signals?agent=${BTC_ADDRESS}`);
    const afterBody = await afterRes.json<{ signals: Array<{ id: string; status: string }> }>();
    const found = afterBody.signals.find((s) => s.id === signalId);
    expect(found).toBeDefined();
    expect(found?.status).toBe("submitted");
  });

  it("removes the staged row entirely when a signal_submission stage is discarded", async () => {
    const signalId = "sig-flow-discard-001";
    await seedPendingSignal(signalId);
    await stageSignalSubmission("pay_signal_flow_discard", signalId);

    await reconcileStage("pay_signal_flow_discard", "failed", { terminalReason: "sender_nonce_stale" });

    const directRes = await SELF.fetch(`http://example.com/api/signals/${signalId}`);
    expect(directRes.status).toBe(404);

    // The staged-payment record is also discarded — confirms cleanup ran.
    const stageRes = await SELF.fetch(`http://example.com/api/test/payment-stage/pay_signal_flow_discard`);
    expect(stageRes.status).toBe(200);
    const stageBody = await stageRes.json<{ data: { stageStatus: string } }>();
    expect(stageBody.data.stageStatus).toBe("discarded");
  });
});
