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

  it("returns pending_payment rows when ?include_pending=true is passed", async () => {
    const id = "sig-visibility-include-pending-001";
    await seedPendingSignal(id);

    const res = await SELF.fetch(
      `http://example.com/api/signals?agent=${BTC_ADDRESS}&include_pending=true`
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ signals: Array<{ id: string; status: string }> }>();
    const found = body.signals.find((s) => s.id === id);
    expect(found).toBeDefined();
    expect(found?.status).toBe("pending_payment");
  });

  it("returns pending_payment rows when ?status=pending_payment is passed", async () => {
    const id = "sig-visibility-status-pending-001";
    await seedPendingSignal(id);

    const res = await SELF.fetch(
      `http://example.com/api/signals?agent=${BTC_ADDRESS}&status=pending_payment`
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ signals: Array<{ id: string; status: string }> }>();
    expect(body.signals.every((s) => s.status === "pending_payment")).toBe(true);
    expect(body.signals.find((s) => s.id === id)).toBeDefined();
  });

  it("excludes pending_payment from /api/signals/counts when neither agent= nor include_pending=true is set", async () => {
    await seedPendingSignal("sig-counts-exclude-001");

    const res = await SELF.fetch("http://example.com/api/signals/counts");
    expect(res.status).toBe(200);
    const body = await res.json<{ pending_payment?: number }>();
    expect(body.pending_payment).toBeUndefined();
  });

  it("includes pending_payment bucket on /api/signals/counts when agent is scoped", async () => {
    const isolatedAddr = "bc1qpending0counts0agent000000000000000000";
    await seedPendingSignal("sig-counts-include-agent-001", { btcAddress: isolatedAddr });

    const res = await SELF.fetch(`http://example.com/api/signals/counts?agent=${isolatedAddr}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ pending_payment?: number }>();
    expect(body.pending_payment).toBeGreaterThanOrEqual(1);
  });

  it("includes pending_payment bucket on /api/signals/counts when include_pending=true", async () => {
    await seedPendingSignal("sig-counts-include-flag-001");

    const res = await SELF.fetch("http://example.com/api/signals/counts?include_pending=true");
    expect(res.status).toBe(200);
    const body = await res.json<{ pending_payment?: number }>();
    expect(body.pending_payment).toBeGreaterThanOrEqual(1);
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

    const includePendingRes = await SELF.fetch(
      `http://example.com/api/signals?agent=${BTC_ADDRESS}&include_pending=true`
    );
    const includePendingBody = await includePendingRes.json<{ signals: Array<{ id: string }> }>();
    expect(includePendingBody.signals.find((s) => s.id === signalId)).toBeUndefined();
  });
});
