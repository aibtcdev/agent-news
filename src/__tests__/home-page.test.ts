import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * Integration tests for the homepage SSR handler (GET /).
 *
 * With run_worker_first: ["/"] the worker intercepts the root, fetches the
 * static shell via env.ASSETS, and streams it through HTMLRewriter to
 * inject dynamic meta + JSON-LD. These tests verify:
 *   - The shell loads via ASSETS and comes back as HTML.
 *   - Head tags (title, description, og:*, twitter:*) get dynamic content
 *     derived from the seeded brief + front-page signals.
 *   - JSON-LD (NewsMediaOrganization, WebSite, ItemList) is injected.
 *   - Original client bootstrap scripts (script tags, topnav placeholder,
 *     /api/init fetch) are preserved — the client UX is untouched.
 *   - Cache-Control is set (Worker responses aren't auto-cached at edge).
 *   - The ?signal= deep-link bootstrap is still present.
 *   - Other root-adjacent paths (e.g. /robots.txt) are NOT intercepted.
 */

const LEAD_HEADLINE =
  "Homepage SSR lead — today's biggest story on AIBTC News";
const SECOND_HEADLINE = "Second story that should appear in ItemList";
const LEAD_ID = "home-ssr-lead-001";
const SECOND_ID = "home-ssr-second-002";

beforeAll(async () => {
  // Seed two approved signals with fresh timestamps so listFrontPage
  // picks them up (its window is -2 days).
  const now = new Date();
  const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const earlier = new Date(now.getTime() - 90 * 60 * 1000).toISOString();

  await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      signals: [
        {
          id: LEAD_ID,
          beat_slug: "bitcoin-macro",
          btc_address: "bc1qhomessrlead0000000000000000000000000000",
          headline: LEAD_HEADLINE,
          body: "Body content for the lead signal used in homepage SSR tests.",
          sources: "[]",
          created_at: recent,
          status: "approved",
          disclosure: "",
        },
        {
          id: SECOND_ID,
          beat_slug: "bitcoin-macro",
          btc_address: "bc1qhomessrsecond000000000000000000000000000",
          headline: SECOND_HEADLINE,
          body: "Body content for the second signal.",
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
// Baseline: still serves HTML with the correct cache story
// ---------------------------------------------------------------------------

describe("GET / — baseline", () => {
  it("returns 200 HTML with explicit Cache-Control", async () => {
    const res = await SELF.fetch("http://example.com/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    // Worker responses aren't auto-cached at the edge — we set this header
    // explicitly so Cloudflare's CDN will hold the rendered homepage.
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=/);
  });

  it("keeps the original client bootstrap scripts intact", async () => {
    const res = await SELF.fetch("http://example.com/");
    const body = await res.text();
    // Client JS must still be present — we only augment the head.
    expect(body).toContain("/shared.js");
    expect(body).toContain("/api/init");
    // Topnav placeholder div (reserved by the client shell) must remain.
    expect(body).toContain('id="topnav-placeholder"');
    // ?signal=:id deep-link bootstrap must still be there so copies of
    // the old URL pattern keep opening the modal.
    expect(body).toContain("params.get('signal')");
  });
});

// ---------------------------------------------------------------------------
// Dynamic head rewrite
// ---------------------------------------------------------------------------

describe("GET / — dynamic head", () => {
  it("rewrites <title> to include the lead headline", async () => {
    const res = await SELF.fetch("http://example.com/");
    const body = await res.text();
    // Title format: "<truncated headline> — AIBTC News".
    // The seeded lead headline is short enough to appear verbatim.
    expect(body).toMatch(
      /<title>Homepage SSR lead — today's biggest story on AIBTC News — AIBTC News<\/title>/
    );
  });

  it("rewrites og:title and twitter:title to match", async () => {
    const res = await SELF.fetch("http://example.com/");
    const body = await res.text();
    expect(body).toMatch(
      /<meta property="og:title" content="Homepage SSR lead — today's biggest story on AIBTC News — AIBTC News">/
    );
    expect(body).toMatch(
      /<meta name="twitter:title" content="Homepage SSR lead — today's biggest story on AIBTC News — AIBTC News">/
    );
  });

  it("rewrites description with today's top headlines when no brief", async () => {
    const res = await SELF.fetch("http://example.com/");
    const body = await res.text();
    // No brief seeded → description falls back to "Today on AIBTC News: ..."
    expect(body).toMatch(
      /<meta name="description" content="Today on AIBTC News: Homepage SSR lead/
    );
    expect(body).toMatch(
      /<meta property="og:description" content="Today on AIBTC News: /
    );
  });
});

// ---------------------------------------------------------------------------
// JSON-LD injection
// ---------------------------------------------------------------------------

describe("GET / — JSON-LD", () => {
  it("injects NewsMediaOrganization + WebSite", async () => {
    const res = await SELF.fetch("http://example.com/");
    const body = await res.text();
    expect(body).toContain('"@type":"NewsMediaOrganization"');
    expect(body).toContain('"@type":"WebSite"');
    expect(body).toContain('"@id":"https://aibtc.news/#org"');
    expect(body).toContain('"@id":"https://aibtc.news/#website"');
  });

  it("injects ItemList with today's top signals", async () => {
    const res = await SELF.fetch("http://example.com/");
    const body = await res.text();
    expect(body).toContain('"@type":"ItemList"');
    expect(body).toContain('"@type":"ListItem"');
    expect(body).toContain(
      `"url":"https://aibtc.news/signals/${LEAD_ID}"`
    );
    // Second signal should also appear.
    expect(body).toContain(
      `"url":"https://aibtc.news/signals/${SECOND_ID}"`
    );
    expect(body).toContain(`"name":"${LEAD_HEADLINE}"`);
  });
});

// ---------------------------------------------------------------------------
// Scope check — run_worker_first must only match "/"
// ---------------------------------------------------------------------------

describe("GET /robots.txt — NOT intercepted by homepage handler", () => {
  it("still serves robots.txt from the SEO router (not the homepage)", async () => {
    const res = await SELF.fetch("http://example.com/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    const body = await res.text();
    // Must not have been run through HTMLRewriter.
    expect(body).not.toContain('"@type":"NewsMediaOrganization"');
  });
});

describe("GET /signals/:id — NOT intercepted by homepage handler", () => {
  it("continues to serve the signal-page router response", async () => {
    const res = await SELF.fetch(
      `http://example.com/signals/${LEAD_ID}`
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Signal-page emits a NewsArticle (not NewsMediaOrganization as first JSON-LD).
    expect(body).toContain('"@type":"NewsArticle"');
  });
});
