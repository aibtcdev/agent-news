import { expect } from "vitest";
import { SELF } from "cloudflare:test";

export const FIXTURE_BTC_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

export interface SeedPendingSignalOpts {
  btcAddress?: string;
  beatSlug?: string;
  headline?: string;
  body?: string | null;
  createdAt?: string;
}

/** Inserts a `pending_payment` signal row via /api/test-seed. Tests use this
 *  to set up rows that the staging endpoints can then finalize or discard. */
export async function seedPendingSignal(
  id: string,
  opts: SeedPendingSignalOpts = {}
): Promise<void> {
  const res = await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      signals: [
        {
          id,
          beat_slug: opts.beatSlug ?? "agent-economy",
          btc_address: opts.btcAddress ?? FIXTURE_BTC_ADDRESS,
          headline: opts.headline ?? `Pending signal ${id}`,
          body: opts.body ?? null,
          sources: JSON.stringify([{ url: "https://example.com", title: "Example" }]),
          created_at: opts.createdAt ?? "2026-04-22T12:00:00.000Z",
          status: "pending_payment",
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
}

export interface StageSignalSubmissionOpts {
  btcAddress?: string;
  beatSlug?: string;
  headline?: string;
  body?: string | null;
}

/** Stages a `signal_submission` payment via /api/test/payment-stage. */
export async function stageSignalSubmission(
  paymentId: string,
  signalId: string,
  opts: StageSignalSubmissionOpts = {}
): Promise<void> {
  const res = await SELF.fetch("http://example.com/api/test/payment-stage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentId,
      payload: {
        kind: "signal_submission",
        signal_id: signalId,
        btc_address: opts.btcAddress ?? FIXTURE_BTC_ADDRESS,
        beat_slug: opts.beatSlug ?? "agent-economy",
        headline: opts.headline ?? `Pending signal ${signalId}`,
        body: opts.body ?? null,
        sources: [{ url: "https://example.com", title: "Example" }],
        tags: [],
        disclosure: null,
        payment_txid: null,
      },
    }),
  });
  expect(res.status).toBe(201);
}

/** Calls /api/test/payment-stage/:id/reconcile and asserts a 200 response. */
export async function reconcileStage(
  paymentId: string,
  status: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const res = await SELF.fetch(
    `http://example.com/api/test/payment-stage/${paymentId}/reconcile`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, ...extra }),
    }
  );
  expect(res.status).toBe(200);
}
