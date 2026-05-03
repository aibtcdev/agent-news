import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * Integration tests for the full-page server-rendered article at
 * GET /signals/:id. Verifies the HTML shape, structured data, canonical
 * URL, and status-based robots directives. These are the surfaces Google
 * and social crawlers actually consume.
 */

const APPROVED_ID = "sigpage-approved-001";
const DRAFT_ID = "sigpage-submitted-002";
const HOSTILE_SOURCE_ID = "sigpage-hostile-003";
const BRIEF_PENDING_ID = "sigpage-brief-pending-004";
const MISSING_ID = "00000000-0000-0000-0000-000000000000";

const APPROVED_ADDR = "bc1qsigpageapproved0000000000000000000000000";
const DRAFT_ADDR = "bc1qsigpagedraft00000000000000000000000000000";
const HOSTILE_ADDR = "bc1qsigpagehostile00000000000000000000000000";
const PENDING_ADDR = "bc1qsigpagebriefpending00000000000000000000";

beforeAll(async () => {
  await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      signals: [
        {
          id: APPROVED_ID,
          beat_slug: "bitcoin-macro",
          btc_address: APPROVED_ADDR,
          headline: "Signal page rendering test — approved story",
          body: "This is the body of an approved signal. It has two paragraphs.\n\nThe second paragraph lives here to prove paragraph splitting works.",
          sources: JSON.stringify([
            { url: "https://example.com/source-1", title: "Example Source" },
          ]),
          tags: ["test-tag", "sigpage"],
          created_at: "2026-04-20T10:00:00Z",
          status: "approved",
          disclosure: "Written by test AI agent for integration coverage.",
        },
        {
          id: DRAFT_ID,
          beat_slug: "bitcoin-macro",
          btc_address: DRAFT_ADDR,
          headline: "Signal page draft that should be noindex",
          body: "Draft body — crawlers should never index this URL.",
          sources: "[]",
          created_at: "2026-04-20T11:00:00Z",
          status: "submitted",
          disclosure: "",
        },
        {
          id: HOSTILE_SOURCE_ID,
          beat_slug: "bitcoin-macro",
          btc_address: HOSTILE_ADDR,
          headline: "Signal with a javascript: source URL",
          body: "Source-URL guard coverage.",
          sources: JSON.stringify([
            { url: "javascript:alert(1)", title: "Evil link" },
          ]),
          created_at: "2026-04-20T12:00:00Z",
          status: "approved",
          disclosure: "",
        },
        {
          id: BRIEF_PENDING_ID,
          beat_slug: "bitcoin-macro",
          btc_address: PENDING_ADDR,
          headline: "Signal in a compiled-but-not-yet-inscribed brief",
          body: "brief-pending provenance copy coverage.",
          sources: "[]",
          created_at: "2026-04-19T08:00:00Z",
          status: "brief_included",
          disclosure: "",
        },
      ],
      briefs: [
        {
          date: "2026-04-19",
          text: "test brief body",
          json_data: null,
          compiled_at: "2026-04-19T23:50:00Z",
          inscribed_txid: null,
          inscription_id: null,
        },
      ],
    }),
  });
});

// ---------------------------------------------------------------------------
// Approved signal — the full SEO story
// ---------------------------------------------------------------------------

describe("GET /signals/:id — approved article", () => {
  it("returns 200 HTML", async () => {
    const res = await SELF.fetch(`http://example.com/signals/${APPROVED_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("includes canonical URL and no JS redirect", async () => {
    const res = await SELF.fetch(`http://example.com/signals/${APPROVED_ID}`);
    const body = await res.text();
    expect(body).toContain(
      `<link rel="canonical" href="https://aibtc.news/signals/${APPROVED_ID}">`
    );
    // The old JS redirect must be gone.
    expect(body).not.toContain("location.replace");
  });

  it("emits index robots directive for approved signals", async () => {
    const res = await SELF.fetch(`http://example.com/signals/${APPROVED_ID}`);
    const body = await res.text();
    expect(body).toMatch(
      /<meta name="robots" content="index,follow,max-image-preview:large/
    );
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });

  it("renders the headline as <h1> and shows the body server-side", async () => {
    const res = await SELF.fetch(`http://example.com/signals/${APPROVED_ID}`);
    const body = await res.text();
    expect(body).toContain(
      "Signal page rendering test — approved story"
    );
    expect(body).toContain("<h1");
    expect(body).toContain("The second paragraph lives here");
  });

  it("embeds NewsArticle JSON-LD with author, publisher, digitalSourceType", async () => {
    const res = await SELF.fetch(`http://example.com/signals/${APPROVED_ID}`);
    const body = await res.text();
    expect(body).toContain('"@type":"NewsArticle"');
    expect(body).toContain('"datePublished"');
    expect(body).toContain('"dateModified"');
    expect(body).toContain('"digitalSourceType"');
    expect(body).toContain("trainedAlgorithmicMedia");
    expect(body).toContain('"creditText"');
    expect(body).toContain('"propertyID":"SignalId"');
  });

  it("embeds BreadcrumbList and Organization JSON-LD", async () => {
    const res = await SELF.fetch(`http://example.com/signals/${APPROVED_ID}`);
    const body = await res.text();
    expect(body).toContain('"@type":"BreadcrumbList"');
    expect(body).toContain('"@type":"Organization"');
    expect(body).toContain('"@id":"https://aibtc.news/#org"');
  });

  it("includes article:published_time, article:section, and open-graph article type", async () => {
    const res = await SELF.fetch(`http://example.com/signals/${APPROVED_ID}`);
    const body = await res.text();
    expect(body).toContain('<meta property="og:type" content="article">');
    expect(body).toContain('<meta property="article:published_time"');
    expect(body).toContain('<meta property="article:section"');
  });

  it("shows an AI disclosure block", async () => {
    const res = await SELF.fetch(`http://example.com/signals/${APPROVED_ID}`);
    const body = await res.text();
    expect(body).toMatch(/AI disclosure/);
    expect(body).toContain("Written by test AI agent for integration coverage.");
  });
});

// ---------------------------------------------------------------------------
// Draft signal — must not be indexed
// ---------------------------------------------------------------------------

describe("GET /signals/:id — draft (submitted)", () => {
  it("returns 200 but marks the page noindex via meta AND header", async () => {
    const res = await SELF.fetch(`http://example.com/signals/${DRAFT_ID}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/<meta name="robots" content="noindex,nofollow">/);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });
});

// ---------------------------------------------------------------------------
// Source URL hardening — reject non-http(s) hrefs at render time
// ---------------------------------------------------------------------------

describe("GET /signals/:id — hostile source URL", () => {
  it("strips javascript: URLs from source hrefs", async () => {
    const res = await SELF.fetch(
      `http://example.com/signals/${HOSTILE_SOURCE_ID}`
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // The source link must not carry the hostile protocol into the DOM.
    expect(body).not.toContain("javascript:alert(1)");
    expect(body).not.toMatch(/href="javascript:/i);
    // The title is still rendered so the source row remains visible.
    expect(body).toContain("Evil link");
  });
});

// ---------------------------------------------------------------------------
// brief_included without inscription — "brief-pending" copy
// ---------------------------------------------------------------------------

describe("GET /signals/:id — brief_included, brief not inscribed", () => {
  it("says 'Awaiting Bitcoin inscription', NOT 'editorial review'", async () => {
    const res = await SELF.fetch(
      `http://example.com/signals/${BRIEF_PENDING_ID}`
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Should mention the brief date and the inscription-pending state.
    expect(body).toMatch(/Included in the 2026-04-19 daily brief/);
    expect(body).toMatch(/Awaiting Bitcoin inscription/);
    // MUST NOT fall through to the stage-fallback copy — brief_included is
    // past editorial review.
    expect(body).not.toMatch(/currently in editorial review/);
    // No inscription markers should leak into JSON-LD or visible DOM.
    expect(body).not.toContain("BitcoinInscriptionId");
    expect(body).not.toContain('"archivedAt"');
  });

  it("emits BriefDate but not BitcoinInscriptionId in JSON-LD identifier", async () => {
    const res = await SELF.fetch(
      `http://example.com/signals/${BRIEF_PENDING_ID}`
    );
    const body = await res.text();
    expect(body).toContain('"propertyID":"BriefDate"');
    expect(body).toContain('"value":"2026-04-19"');
    expect(body).not.toContain('"propertyID":"BitcoinInscriptionId"');
  });
});

// ---------------------------------------------------------------------------
// 404 — signal not found
// ---------------------------------------------------------------------------

describe("GET /signals/:id — not found", () => {
  it("returns 404 HTML (not a 302 redirect)", async () => {
    const res = await SELF.fetch(`http://example.com/signals/${MISSING_ID}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const body = await res.text();
    expect(body).toContain("Signal not found");
    expect(body).toContain(MISSING_ID);
  });
});
