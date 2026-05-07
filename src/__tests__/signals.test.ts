import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

const PAGING_TAG = "paging-lower-bound-700";
const LARGE_PAGE_TAG = "large-page-tag-hydration";
const REVIEWED_BY_TAG = "reviewed-by-metadata";
const REVIEWER_BTC_ADDRESS = "bc1q2a79dmk06ct6v206sqtp3agw8kg64dz40vhjeg";

async function seed(body: Record<string, unknown>) {
  const res = await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

/**
 * Integration tests for /api/signals endpoints.
 * Tests validation layer and error responses (happy-path CRUD requires BIP-322 auth).
 */
describe("GET /api/signals", () => {
  it("returns 200 with signal list shape", async () => {
    const res = await SELF.fetch("http://example.com/api/signals");
    expect(res.status).toBe(200);
    const body = await res.json<{
      signals: unknown[];
      total: number;
      filtered: number;
    }>();
    expect(Array.isArray(body.signals)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.filtered).toBe("number");
  });

  it("accepts query parameters without error", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals?limit=10&beat=tech"
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /api/signals — bounded pagination metadata", () => {
  it("returns hasMore and a bounded total without over-reporting empty pages", async () => {
    await seed({
      signals: [
        {
          id: "paging-700-001",
          beat_slug: "agent-social",
          btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
          headline: "Paging test first",
          sources: "[]",
          created_at: "2026-04-30T12:03:00.000Z",
          status: "approved",
          reviewed_at: "2026-04-30T12:04:00.000Z",
        },
        {
          id: "paging-700-002",
          beat_slug: "agent-social",
          btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
          headline: "Paging test second",
          sources: "[]",
          created_at: "2026-04-30T12:02:00.000Z",
          status: "approved",
          reviewed_at: "2026-04-30T12:04:00.000Z",
        },
        {
          id: "paging-700-003",
          beat_slug: "agent-social",
          btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
          headline: "Paging test third",
          sources: "[]",
          created_at: "2026-04-30T12:01:00.000Z",
          status: "approved",
          reviewed_at: "2026-04-30T12:04:00.000Z",
        },
      ],
      signal_tags: [
        { signal_id: "paging-700-001", tag: PAGING_TAG },
        { signal_id: "paging-700-002", tag: PAGING_TAG },
        { signal_id: "paging-700-003", tag: PAGING_TAG },
      ],
    });

    const firstRes = await SELF.fetch(
      `http://example.com/api/signals?tag=${PAGING_TAG}&limit=2`
    );
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json<{
      signals: unknown[];
      total: number;
      hasMore: boolean;
    }>();
    expect(firstBody.signals).toHaveLength(2);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.total).toBe(3);

    const secondRes = await SELF.fetch(
      `http://example.com/api/signals?tag=${PAGING_TAG}&limit=2&offset=2`
    );
    expect(secondRes.status).toBe(200);
    const secondBody = await secondRes.json<{
      signals: unknown[];
      total: number;
      hasMore: boolean;
    }>();
    expect(secondBody.signals).toHaveLength(1);
    expect(secondBody.hasMore).toBe(false);
    expect(secondBody.total).toBe(3);

    const beyondRes = await SELF.fetch(
      `http://example.com/api/signals?tag=${PAGING_TAG}&limit=2&offset=100`
    );
    expect(beyondRes.status).toBe(200);
    const beyondBody = await beyondRes.json<{
      signals: unknown[];
      total: number;
      hasMore: boolean;
    }>();
    expect(beyondBody.signals).toHaveLength(0);
    expect(beyondBody.hasMore).toBe(false);
    expect(beyondBody.total).toBe(0);
  }, 30_000);

  it("hydrates tags for a 200-row page without exceeding DO SQLite variable limits", async () => {
    const signals = Array.from({ length: 201 }, (_, index) => {
      const n = String(index + 1).padStart(3, "0");
      return {
        id: `large-page-tag-${n}`,
        beat_slug: "bitcoin-macro",
        btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        headline: `Large page tag hydration ${n}`,
        sources: "[]",
        created_at: `2026-04-30T13:${String(index % 60).padStart(2, "0")}:00.000Z`,
        status: "brief_included",
        reviewed_at: "2026-04-30T14:00:00.000Z",
      };
    });

    await seed({
      signals,
      signal_tags: signals.map((signal) => ({
        signal_id: signal.id,
        tag: LARGE_PAGE_TAG,
      })),
    });

    const res = await SELF.fetch(
      `http://example.com/api/signals?beat=bitcoin-macro&status=brief_included&tag=${LARGE_PAGE_TAG}&limit=500`
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      signals: Array<{ tags: string[] }>;
      filtered: number;
      hasMore: boolean;
    }>();
    expect(body.filtered).toBe(200);
    expect(body.hasMore).toBe(true);
    expect(body.signals).toHaveLength(200);
    expect(body.signals.length).toBe(body.filtered);
    expect(body.signals.every((signal) => signal.tags.includes(LARGE_PAGE_TAG))).toBe(true);
  }, 30_000);
});

describe("GET /api/signals — review metadata", () => {
  it("exposes reviewedBy on reviewed signals and null for submitted signals", async () => {
    await seed({
      signals: [
        {
          id: "reviewed-by-approved-001",
          beat_slug: "quantum",
          btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
          headline: "Reviewed signal attribution",
          sources: "[]",
          created_at: "2026-04-30T15:01:00.000Z",
          status: "approved",
          reviewed_by: REVIEWER_BTC_ADDRESS,
          reviewed_at: "2026-04-30T16:00:00.000Z",
        },
        {
          id: "reviewed-by-submitted-001",
          beat_slug: "quantum",
          btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
          headline: "Submitted signal without attribution",
          sources: "[]",
          created_at: "2026-04-30T15:02:00.000Z",
          status: "submitted",
          reviewed_by: null,
          reviewed_at: null,
        },
      ],
      signal_tags: [
        { signal_id: "reviewed-by-approved-001", tag: REVIEWED_BY_TAG },
        { signal_id: "reviewed-by-submitted-001", tag: REVIEWED_BY_TAG },
      ],
    });

    const listRes = await SELF.fetch(
      `http://example.com/api/signals?tag=${REVIEWED_BY_TAG}&limit=10`
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json<{ signals: Array<{ id: string; reviewedBy: string | null }> }>();
    const approved = listBody.signals.find((signal) => signal.id === "reviewed-by-approved-001");
    const submitted = listBody.signals.find((signal) => signal.id === "reviewed-by-submitted-001");
    expect(approved?.reviewedBy).toBe(REVIEWER_BTC_ADDRESS);
    expect(submitted?.reviewedBy).toBeNull();

    const singleRes = await SELF.fetch("http://example.com/api/signals/reviewed-by-approved-001");
    expect(singleRes.status).toBe(200);
    const singleBody = await singleRes.json<{ reviewedAt: string; reviewedBy: string | null }>();
    expect(singleBody.reviewedAt).toBe("2026-04-30T16:00:00.000Z");
    expect(singleBody.reviewedBy).toBe(REVIEWER_BTC_ADDRESS);
  }, 30_000);
});

describe("GET /api/signals/:id — not found", () => {
  it("returns 404 for a nonexistent signal ID", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("not found");
  });
});

describe("POST /api/signals — validation errors", () => {
  it("returns 400 when body is not valid JSON", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headline: "Something happened" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("Missing required fields");
  });

  it("returns 400 for an invalid beat_slug", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beat_slug: "INVALID SLUG!",
        btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        headline: "Something happened",
        sources: [{ url: "https://example.com", title: "Example" }],
        tags: ["bitcoin"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("beat_slug");
  });

  it("returns 400 for an invalid BTC address", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beat_slug: "my-beat",
        btc_address: "not-a-btc-address",
        headline: "Something happened",
        sources: [{ url: "https://example.com", title: "Example" }],
        tags: ["bitcoin"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("BTC address");
  });

  it("returns 400 for an invalid headline (too long)", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beat_slug: "my-beat",
        btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        headline: "a".repeat(121),
        sources: [{ url: "https://example.com", title: "Example" }],
        tags: ["bitcoin"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("headline");
  });

  it("returns 400 for invalid sources (empty array)", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beat_slug: "my-beat",
        btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        headline: "Something happened",
        sources: [],
        tags: ["bitcoin"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("sources");
  });

  it("returns 400 for invalid tags (uppercase)", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beat_slug: "my-beat",
        btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        headline: "Something happened",
        sources: [{ url: "https://example.com", title: "Example" }],
        tags: ["BITCOIN"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("tags");
  });

  it("returns 404 for a nonexistent beat before reaching auth", async () => {
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beat_slug: "my-beat",
        btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        headline: "Something happened",
        sources: [{ url: "https://example.com", title: "Example" }],
        tags: ["bitcoin"],
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("not found");
  });
});
