/**
 * GET /api/signals — `reviewed_since` filter semantics (issue #819)
 *
 * `since` filters on `created_at`. `reviewed_since` filters on `reviewed_at`.
 * Callers that compute review-window metrics (editor activity, queue velocity)
 * must use `reviewed_since`, not `since`, or they silently miss signals created
 * before the window but reviewed inside it.
 */
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

const REPORTER = "bc1qreviewed819testaddr000000000000000000000";
const BEAT = "agent-social";

async function seed(body: Record<string, unknown>) {
  const res = await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

async function listSignals(query: string) {
  const res = await SELF.fetch(`http://example.com/api/signals${query}`);
  expect(res.status).toBe(200);
  const body = await res.json<{ signals: { id: string }[] }>();
  return body.signals.map((s) => s.id);
}

describe("GET /api/signals — reviewed_since filter", () => {
  it("includes a signal created before the window but reviewed inside it", async () => {
    // Signal created 2 days ago, reviewed 1 hour ago.
    // `since=yesterday` should NOT include it; `reviewed_since=yesterday` should.
    await seed({
      signals: [
        {
          id: "rs-819-old-created-new-reviewed",
          beat_slug: BEAT,
          btc_address: REPORTER,
          headline: "Created old, reviewed new",
          sources: "[]",
          created_at: "2026-05-06T10:00:00.000Z",
          status: "approved",
          reviewed_at: "2026-05-08T10:00:00.000Z",
        },
        {
          id: "rs-819-new-created-new-reviewed",
          beat_slug: BEAT,
          btc_address: REPORTER,
          headline: "Created new, reviewed new",
          sources: "[]",
          created_at: "2026-05-08T09:00:00.000Z",
          status: "approved",
          reviewed_at: "2026-05-08T10:30:00.000Z",
        },
      ],
    });

    const windowStart = "2026-05-07T00:00:00.000Z";

    // `since` (created_at lower-bound): only the new-created signal is visible
    const bySince = await listSignals(`?since=${windowStart}&status=approved&beat=${BEAT}`);
    expect(bySince).toContain("rs-819-new-created-new-reviewed");
    expect(bySince).not.toContain("rs-819-old-created-new-reviewed");

    // `reviewed_since` (reviewed_at lower-bound): both signals are visible
    const byReviewedSince = await listSignals(
      `?reviewed_since=${windowStart}&status=approved&beat=${BEAT}`
    );
    expect(byReviewedSince).toContain("rs-819-old-created-new-reviewed");
    expect(byReviewedSince).toContain("rs-819-new-created-new-reviewed");
  });

  it("excludes a signal reviewed before the window even if created inside it", async () => {
    await seed({
      signals: [
        {
          id: "rs-819-new-created-old-reviewed",
          beat_slug: BEAT,
          btc_address: REPORTER,
          headline: "Created new, reviewed old",
          sources: "[]",
          created_at: "2026-05-08T08:00:00.000Z",
          status: "approved",
          reviewed_at: "2026-05-06T12:00:00.000Z",
        },
      ],
    });

    const windowStart = "2026-05-07T00:00:00.000Z";

    // Appears under `since` (created in window)
    const bySince = await listSignals(`?since=${windowStart}&status=approved&beat=${BEAT}`);
    expect(bySince).toContain("rs-819-new-created-old-reviewed");

    // Absent under `reviewed_since` (reviewed before window)
    const byReviewedSince = await listSignals(
      `?reviewed_since=${windowStart}&status=approved&beat=${BEAT}`
    );
    expect(byReviewedSince).not.toContain("rs-819-new-created-old-reviewed");
  });
});
