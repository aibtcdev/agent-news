import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

const BTC_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

async function stageClassified(paymentId: string, classifiedId: string) {
  const res = await SELF.fetch("http://example.com/api/test/payment-stage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentId,
      payload: {
        kind: "classified_submission",
        classified_id: classifiedId,
        btc_address: BTC_ADDRESS,
        category: "services",
        headline: "Staged via sweep test",
        body: "Delivered without client poll",
        payment_txid: null,
      },
    }),
  });
  expect(res.status).toBe(201);
}

async function runSweep(
  results: Record<string, { status: string; txid?: string; terminalReason?: string }>,
  graceMs = 0
): Promise<number> {
  const res = await SELF.fetch("http://example.com/api/test/sweep-staged-payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ graceMs, limit: 10, results }),
  });
  expect(res.status).toBe(200);
  const body = await res.json<{ data: { reconciled: number } }>();
  return body.data.reconciled;
}

describe("payment staging alarm sweep (#572)", () => {
  // Warm the worker + DO before the first real assertion so the 15s testTimeout
  // isn't eaten by cold-start. Mirrors the pattern used in payment-staging.test.ts's
  // passing cases which always warm via an earlier test in the same file.
  beforeAll(async () => {
    await SELF.fetch("http://example.com/api/health");
  });

  it("finalizes a confirmed staged payment without any client poll", async () => {
    const paymentId = "pay_sweep_confirmed_001";
    const classifiedId = "cl-sweep-confirmed-001";
    await stageClassified(paymentId, classifiedId);

    const reconciled = await runSweep({
      [paymentId]: { status: "confirmed", txid: "a".repeat(64) },
    });
    expect(reconciled).toBe(1);

    const stageRes = await SELF.fetch(`http://example.com/api/test/payment-stage/${paymentId}`);
    const stageBody = await stageRes.json<{ data: { stageStatus: string; finalizedAt: string | null } }>();
    expect(stageBody.data.stageStatus).toBe("finalized");
    expect(stageBody.data.finalizedAt).not.toBeNull();
  });

  it("discards a staged payment when the relay reports a terminal failure", async () => {
    const paymentId = "pay_sweep_failed_001";
    const classifiedId = "cl-sweep-failed-001";
    await stageClassified(paymentId, classifiedId);

    const reconciled = await runSweep({
      [paymentId]: { status: "failed", terminalReason: "sender_nonce_stale" },
    });
    expect(reconciled).toBe(1);

    const stageRes = await SELF.fetch(`http://example.com/api/test/payment-stage/${paymentId}`);
    const stageBody = await stageRes.json<{
      data: { stageStatus: string; terminalStatus: string | null; terminalReason: string | null };
    }>();
    expect(stageBody.data.stageStatus).toBe("discarded");
    expect(stageBody.data.terminalStatus).toBe("failed");
    expect(stageBody.data.terminalReason).toBe("sender_nonce_stale");
  });

  it("leaves a still-pending staged payment untouched for the next tick", async () => {
    const paymentId = "pay_sweep_pending_001";
    const classifiedId = "cl-sweep-pending-001";
    await stageClassified(paymentId, classifiedId);

    const reconciled = await runSweep({
      [paymentId]: { status: "mempool", txid: "b".repeat(64) },
    });
    expect(reconciled).toBe(0);

    const stageRes = await SELF.fetch(`http://example.com/api/test/payment-stage/${paymentId}`);
    const stageBody = await stageRes.json<{ data: { stageStatus: string } }>();
    expect(stageBody.data.stageStatus).toBe("staged");
  });

  it("recovers an expired row when the relay finally confirms (late settlement)", async () => {
    // Rows that cross the 24h TTL are marked 'expired' but kept in the table
    // precisely so late on-chain confirmations can still deliver. Confirmed by
    // #572's repro comment — jingswap.btc classifieds sat staged for days.
    const paymentId = "pay_sweep_expired_001";
    const classifiedId = "cl-sweep-expired-001";
    await stageClassified(paymentId, classifiedId);

    const expireRes = await SELF.fetch(
      `http://example.com/api/test/payment-stage/${paymentId}/force-expire`,
      { method: "POST" }
    );
    expect(expireRes.status).toBe(200);
    const expireBody = await expireRes.json<{ data: { stageStatus: string } }>();
    expect(expireBody.data.stageStatus).toBe("expired");

    const reconciled = await runSweep({
      [paymentId]: { status: "confirmed", txid: "f".repeat(64) },
    });
    expect(reconciled).toBe(1);

    const stageRes = await SELF.fetch(`http://example.com/api/test/payment-stage/${paymentId}`);
    const stageBody = await stageRes.json<{ data: { stageStatus: string } }>();
    expect(stageBody.data.stageStatus).toBe("finalized");
  });

  it("bumps updated_at on non-terminal sweeps so rows rotate instead of starve", async () => {
    // A pending row left in 'staged' must have its updated_at advanced on each
    // check. Without this, ORDER BY updated_at ASC would pin the same rows at
    // the front of the queue forever and starve newer stagings.
    const paymentId = "pay_sweep_rotate_bump";
    await stageClassified(paymentId, "cl-sweep-rotate-bump");

    const before = await SELF.fetch(`http://example.com/api/test/payment-stage/${paymentId}`);
    const beforeBody = await before.json<{ data: { updatedAt: string; stageStatus: string } }>();
    expect(beforeBody.data.stageStatus).toBe("staged");
    const originalUpdatedAt = beforeBody.data.updatedAt;

    // A non-terminal response — row stays 'staged' but updated_at should advance.
    await new Promise((r) => setTimeout(r, 20));
    const reconciled = await runSweep({ [paymentId]: { status: "mempool" } });
    expect(reconciled).toBe(0);

    const after = await SELF.fetch(`http://example.com/api/test/payment-stage/${paymentId}`);
    const afterBody = await after.json<{ data: { updatedAt: string; stageStatus: string } }>();
    expect(afterBody.data.stageStatus).toBe("staged");
    expect(afterBody.data.updatedAt > originalUpdatedAt).toBe(true);
  });

  it("skips rows still inside the grace window to avoid racing the POST reconcile", async () => {
    const paymentId = "pay_sweep_grace_001";
    const classifiedId = "cl-sweep-grace-001";
    await stageClassified(paymentId, classifiedId);

    // Default grace is 30s; row just staged should be ignored when graceMs large.
    const reconciledWithGrace = await runSweep(
      { [paymentId]: { status: "confirmed", txid: "c".repeat(64) } },
      60_000
    );
    expect(reconciledWithGrace).toBe(0);

    // With graceMs=0, sweep picks it up.
    const reconciledNow = await runSweep(
      { [paymentId]: { status: "confirmed", txid: "c".repeat(64) } },
      0
    );
    expect(reconciledNow).toBe(1);
  });

  it("no-ops when X402_RELAY has no checkPayment and no stub is provided", async () => {
    const paymentId = "pay_sweep_no_relay_001";
    const classifiedId = "cl-sweep-no-relay-001";
    await stageClassified(paymentId, classifiedId);

    // No `results` field — DO falls back to this.env.X402_RELAY, which in the
    // test miniflare config is a plain Fetcher (no checkPayment method).
    const res = await SELF.fetch("http://example.com/api/test/sweep-staged-payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graceMs: 0 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { reconciled: number } }>();
    expect(body.data.reconciled).toBe(0);

    const stageRes = await SELF.fetch(`http://example.com/api/test/payment-stage/${paymentId}`);
    const stageBody = await stageRes.json<{ data: { stageStatus: string } }>();
    expect(stageBody.data.stageStatus).toBe("staged");
  });
});
