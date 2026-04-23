import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * Integration tests for the beat page (GET /beats/:slug).
 *
 * Seeds two approved signals on the `bitcoin-macro` beat (which is created
 * by the DO's migration layer on boot) so the handler has something to
 * render in the ItemList / recent-signals HTML.
 */

const BEAT_SLUG = "bitcoin-macro";
const LEAD_HEADLINE = "Beat-page SSR lead — bitcoin-macro signal A";
const SECOND_HEADLINE = "Beat-page SSR — bitcoin-macro signal B";
const LEAD_ID = "beat-page-lead-001";
const SECOND_ID = "beat-page-second-002";

beforeAll(async () => {
  const now = Date.now();
  const recent = new Date(now - 30 * 60 * 1000).toISOString();
  const earlier = new Date(now - 90 * 60 * 1000).toISOString();

  await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      signals: [
        {
          id: LEAD_ID,
          beat_slug: BEAT_SLUG,
          btc_address: "bc1qbeatpagetest00000000000000000000000000a1",
          headline: LEAD_HEADLINE,
          body: "Body content for beat-page test signal A.",
          sources: "[]",
          created_at: recent,
          status: "approved",
          disclosure: "",
        },
        {
          id: SECOND_ID,
          beat_slug: BEAT_SLUG,
          btc_address: "bc1qbeatpagetest00000000000000000000000000b2",
          headline: SECOND_HEADLINE,
          body: "Body content for beat-page test signal B.",
          sources: "[]",
          created_at: earlier,
          status: "approved",
          disclosure: "",
        },
      ],
    }),
  });
});

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

describe("GET /beats/:slug — baseline", () => {
  it("returns 200 HTML for a known beat", async () => {
    const res = await SELF.fetch(`http://example.com/beats/${BEAT_SLUG}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=/);
  });

  it("sets the canonical URL to the clean path-param form", async () => {
    const res = await SELF.fetch(`http://example.com/beats/${BEAT_SLUG}`);
    const body = await res.text();
    expect(body).toContain(
      `<link rel="canonical" href="https://aibtc.news/beats/${BEAT_SLUG}">`
    );
  });

  it("renders seeded signals in the recent list", async () => {
    const res = await SELF.fetch(`http://example.com/beats/${BEAT_SLUG}`);
    const body = await res.text();
    expect(body).toContain(LEAD_HEADLINE);
    expect(body).toContain(SECOND_HEADLINE);
    expect(body).toContain(`/signals/${LEAD_ID}`);
    expect(body).toContain(`/signals/${SECOND_ID}`);
  });
});

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

describe("GET /beats/:slug — JSON-LD", () => {
  it("emits CollectionPage with the beat slug as identifier", async () => {
    const res = await SELF.fetch(`http://example.com/beats/${BEAT_SLUG}`);
    const body = await res.text();
    expect(body).toContain('"@type":"CollectionPage"');
    expect(body).toContain(`"identifier":"${BEAT_SLUG}"`);
    expect(body).toContain(
      `"@id":"https://aibtc.news/beats/${BEAT_SLUG}#collection"`
    );
  });

  it("includes BreadcrumbList + NewsMediaOrganization", async () => {
    const res = await SELF.fetch(`http://example.com/beats/${BEAT_SLUG}`);
    const body = await res.text();
    expect(body).toContain('"@type":"BreadcrumbList"');
    expect(body).toContain('"@type":"NewsMediaOrganization"');
  });

  it("includes ItemList with signal URLs", async () => {
    const res = await SELF.fetch(`http://example.com/beats/${BEAT_SLUG}`);
    const body = await res.text();
    expect(body).toContain('"@type":"ItemList"');
    expect(body).toContain(
      `"url":"https://aibtc.news/signals/${LEAD_ID}"`
    );
  });
});

// ---------------------------------------------------------------------------
// 404 paths
// ---------------------------------------------------------------------------

describe("GET /beats/:slug — 404 paths", () => {
  it("returns 404 + noindex for an invalid slug shape", async () => {
    const res = await SELF.fetch("http://example.com/beats/foo.php");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const body = await res.text();
    expect(body).toContain("Beat not found");
  });

  it("returns 404 + noindex for a well-formed but unknown slug", async () => {
    const res = await SELF.fetch(
      "http://example.com/beats/not-a-real-beat-slug"
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });
});

// ---------------------------------------------------------------------------
// Sitemap integration
// ---------------------------------------------------------------------------

describe("/sitemap/beats.xml", () => {
  it("lists the beat URL we just added signals to", async () => {
    const res = await SELF.fetch("http://example.com/sitemap/beats.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/xml/);
    const body = await res.text();
    expect(body).toContain(`https://aibtc.news/beats/${BEAT_SLUG}`);
  });
});
