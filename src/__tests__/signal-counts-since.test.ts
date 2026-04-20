/**
 * GET /api/signals/counts — `since` filter semantics (#503)
 *
 * Context: when back-filling historical signals the Publisher may insert rows
 * with `created_at = now` while their operational relevance is a historical
 * day (or the reverse — recent filings whose editorial review landed in a
 * later window). The `since` filter is supposed to answer "what happened in
 * this window", so:
 *
 *   - `submitted` rows bucket by creation time        (`created_at`)
 *   - reviewed rows (`approved`, `brief_included`,
 *     `rejected`, `replaced`) bucket by review time   (`reviewed_at`,
 *                                                      COALESCE → created_at
 *                                                      for legacy NULLs)
 *
 * This test proves the #503 reporter's scenario: bulk-backfilling approved
 * signals with historical `reviewed_at` no longer inflates today's approved
 * count, while signals reviewed today continue to count correctly.
 */
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

const REPORTER = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const BEAT = "agent-social";

async function seed(body: Record<string, unknown>) {
  const res = await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

async function counts(query: string) {
  const res = await SELF.fetch(`http://example.com/api/signals/counts${query}`);
  expect(res.status).toBe(200);
  // The public route returns the unwrapped counts object directly (see
  // signal-counts.ts + lib/do-client.ts#getSignalCounts). The DO-internal
  // handler wraps in { ok, data } but the public route hands `data` back raw.
  return res.json<{
    submitted: number;
    approved: number;
    brief_included: number;
    rejected: number;
    replaced: number;
    total: number;
  }>();
}

describe("GET /api/signals/counts — `since` filter semantics (#503)", () => {
  it("bucket approved signals by reviewed_at, not created_at, when `since` is set", async () => {
    // Two signals, both CREATED today (as if bulk-backfilled right now), but
    // one was REVIEWED today and the other was REVIEWED 5 days ago.
    const todayCreated = "2026-04-18T04:00:00Z";
    const reviewedToday = "2026-04-18T04:30:00Z";
    const reviewedLastWeek = "2026-04-13T10:00:00Z";

    await seed({
      signals: [
        {
          id: "503-approved-today",
          beat_slug: BEAT,
          btc_address: REPORTER,
          headline: "Reviewed today — should count",
          sources: "[]",
          created_at: todayCreated,
          status: "approved",
          reviewed_at: reviewedToday,
        },
        {
          id: "503-approved-last-week",
          beat_slug: BEAT,
          btc_address: REPORTER,
          headline: "Backfilled with historical reviewed_at — should NOT count today",
          sources: "[]",
          created_at: todayCreated, // backfill-shaped: creation is today
          status: "approved",
          reviewed_at: reviewedLastWeek,
        },
      ],
    });

    const todayMidnight = "2026-04-18T00:00:00Z";
    const body = await counts(
      `?beat=${BEAT}&since=${encodeURIComponent(todayMidnight)}`
    );

    // Only the one reviewed today should count; the backfilled one (reviewed
    // a week ago) is excluded from today's bucket even though its created_at
    // is today. Pre-fix this would have returned 2.
    expect(body.approved).toBe(1);
  });

  it("still counts submitted rows by created_at when `since` is set", async () => {
    const todayCreated = "2026-04-18T05:00:00Z";

    await seed({
      signals: [
        {
          id: "503-submitted-today",
          beat_slug: BEAT,
          btc_address: REPORTER,
          headline: "Submitted today",
          sources: "[]",
          created_at: todayCreated,
          status: "submitted",
        },
      ],
    });

    const todayMidnight = "2026-04-18T00:00:00Z";
    const body = await counts(
      `?beat=${BEAT}&since=${encodeURIComponent(todayMidnight)}`
    );

    expect(body.submitted).toBeGreaterThanOrEqual(1);
  });

  it("counts legacy approved rows (NULL reviewed_at) under created_at via COALESCE", async () => {
    const historicalCreated = "2026-03-01T10:00:00Z";

    await seed({
      signals: [
        {
          id: "503-legacy-null-reviewed-at",
          beat_slug: BEAT,
          btc_address: REPORTER,
          headline: "Pre-reviewed_at-column row",
          sources: "[]",
          created_at: historicalCreated,
          status: "approved",
          reviewed_at: null,
        },
      ],
    });

    // Window starting AFTER the historical created_at — endpoint must still
    // respond successfully with a well-formed counts envelope even when
    // reviewed_at is NULL on candidate rows. Smoke test against a SQL-NULL
    // regression in the COALESCE branch.
    const recent = "2026-04-01T00:00:00Z";
    const windowed = await counts(
      `?beat=${BEAT}&since=${encodeURIComponent(recent)}`
    );
    expect(typeof windowed.approved).toBe("number");

    // Window starting BEFORE the historical created_at — COALESCE(NULL, created_at)
    // falls back to the row's creation time, so the row is included.
    const veryOld = "2026-01-01T00:00:00Z";
    const wide = await counts(
      `?beat=${BEAT}&since=${encodeURIComponent(veryOld)}`
    );
    expect(wide.approved).toBeGreaterThanOrEqual(1);
  });

  it("returns all rows when `since` is not provided", async () => {
    const body = await counts("");
    // No filter → all seeded rows visible. Sanity check that the new query
    // still handles the NULL-since path identically to the prior behaviour.
    expect(body.total).toBeGreaterThan(0);
  });
});
