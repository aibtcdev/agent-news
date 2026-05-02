import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

const EDITOR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const CONTRIBUTOR = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const BEAT_SLUG = "quantum";

async function seed(body: Record<string, unknown>) {
  const res = await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

describe("GET /api/world-model/beat-health", () => {
  it("returns DRI-queryable beat health with editor recency and signal status counts", async () => {
    await seed({
      beats: [
        {
          slug: BEAT_SLUG,
          name: "Quantum",
          description: "Quantum safety coverage",
          color: "#7c3aed",
          status: "active",
          created_by: EDITOR,
          created_at: "2026-05-01T00:00:00Z",
          updated_at: "2026-05-01T00:00:00Z",
          editor: { btc_address: EDITOR, registered_at: "2026-05-01T01:00:00Z" },
          members: [{ btc_address: CONTRIBUTOR, claimed_at: "2026-05-01T02:00:00Z" }],
        },
      ],
      signals: [
        {
          id: "wm-approved",
          beat_slug: BEAT_SLUG,
          btc_address: CONTRIBUTOR,
          headline: "Approved quantum signal",
          sources: "[]",
          status: "approved",
          created_at: "2026-05-01T03:00:00Z",
          reviewed_at: "2026-05-01T04:00:00Z",
        },
        {
          id: "wm-submitted",
          beat_slug: BEAT_SLUG,
          btc_address: CONTRIBUTOR,
          headline: "Submitted quantum signal",
          sources: "[]",
          status: "submitted",
          created_at: "2026-05-01T05:00:00Z",
        },
        {
          id: "wm-rejected",
          beat_slug: BEAT_SLUG,
          btc_address: CONTRIBUTOR,
          headline: "Rejected quantum signal",
          sources: "[]",
          status: "rejected",
          created_at: "2026-05-01T05:30:00Z",
          reviewed_at: "2026-05-01T06:00:00Z",
        },
      ],
    });

    const res = await SELF.fetch("http://example.com/api/world-model/beat-health?since=2026-05-01T00%3A00%3A00Z");
    expect(res.status).toBe(200);
    const body = await res.json<{
      generatedAt: string;
      window: { since: string };
      beats: Array<{
        slug: string;
        status: string;
        editor: { address: string; assignedAt: string; lastReviewedAt: string | null } | null;
        members: { count: number };
        signals: { submitted: number; approved: number; rejected: number; total: number };
        coverageGapIndex: number;
      }>;
      totals: { beats: number; activeBeats: number; signals: number; submitted: number; approved: number; rejected: number };
    }>();

    expect(body.window.since).toBe("2026-05-01T00:00:00Z");
    const quantum = body.beats.find((beat) => beat.slug === BEAT_SLUG);
    expect(quantum).toMatchObject({
      slug: BEAT_SLUG,
      signals: { submitted: 1, approved: 1, rejected: 1, total: 3 },
      coverageGapIndex: 0.3333,
    });
    expect(body.totals.beats).toBeGreaterThanOrEqual(1);
    expect(body.totals.activeBeats).toBeGreaterThanOrEqual(0);
    expect(body.totals.signals).toBeGreaterThanOrEqual(3);
    expect(body.totals.submitted).toBeGreaterThanOrEqual(1);
    expect(body.totals.approved).toBeGreaterThanOrEqual(1);
    expect(body.totals.rejected).toBeGreaterThanOrEqual(1);
    expect(typeof body.generatedAt).toBe("string");
  });

  it("rejects malformed since query params", async () => {
    const res = await SELF.fetch("http://example.com/api/world-model/beat-health?since=yesterday");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ ok: false });
  });
});
