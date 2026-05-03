import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * Integration tests for the agent profile page (GET /agents/:addr).
 *
 * Seeds two approved signals for a known test address so the handler has
 * something to render in the ItemList / recent-signals HTML.
 */

const AGENT_ADDR = "bc1qagentpagetest000000000000000000000000000";
const OTHER_ADDR = "bc1qunknownagent000000000000000000000000000x";
const LEAD_HEADLINE = "Agent-page SSR lead — first seeded signal";
const SECOND_HEADLINE = "Agent-page SSR second — also seeded";
const LEAD_ID = "agent-page-lead-001";
const SECOND_ID = "agent-page-second-002";

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
          beat_slug: "bitcoin-macro",
          btc_address: AGENT_ADDR,
          headline: LEAD_HEADLINE,
          body: "Body content for the lead signal in agent-page tests.",
          sources: "[]",
          created_at: recent,
          status: "approved",
          disclosure: "",
        },
        {
          id: SECOND_ID,
          beat_slug: "bitcoin-macro",
          btc_address: AGENT_ADDR,
          headline: SECOND_HEADLINE,
          body: "Body content for the second agent signal.",
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

describe("GET /agents/:addr — baseline", () => {
  it("returns 200 HTML with cache headers for a known agent", async () => {
    const res = await SELF.fetch(`http://example.com/agents/${AGENT_ADDR}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=/);
  });

  it("renders the short + full address in the header", async () => {
    const res = await SELF.fetch(`http://example.com/agents/${AGENT_ADDR}`);
    const body = await res.text();
    // Full address should appear in the <code class="ap-addr-full"> block.
    expect(body).toContain(AGENT_ADDR);
    // Canonical URL should be the clean path-param form.
    expect(body).toContain(
      `<link rel="canonical" href="https://aibtc.news/agents/${AGENT_ADDR}">`
    );
  });

  it("includes the seeded signals in the rendered recent list", async () => {
    const res = await SELF.fetch(`http://example.com/agents/${AGENT_ADDR}`);
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

describe("GET /agents/:addr — JSON-LD", () => {
  it("emits ProfilePage + Person with BitcoinAddress identifier", async () => {
    const res = await SELF.fetch(`http://example.com/agents/${AGENT_ADDR}`);
    const body = await res.text();
    expect(body).toContain('"@type":"ProfilePage"');
    expect(body).toContain('"@type":"Person"');
    expect(body).toContain('"propertyID":"BitcoinAddress"');
    expect(body).toContain(`"value":"${AGENT_ADDR}"`);
    expect(body).toContain(
      `"@id":"https://aibtc.news/agents/${AGENT_ADDR}#person"`
    );
  });

  it("includes BreadcrumbList + NewsMediaOrganization", async () => {
    const res = await SELF.fetch(`http://example.com/agents/${AGENT_ADDR}`);
    const body = await res.text();
    expect(body).toContain('"@type":"BreadcrumbList"');
    expect(body).toContain('"@type":"NewsMediaOrganization"');
  });

  it("includes ItemList of the agent's signals", async () => {
    const res = await SELF.fetch(`http://example.com/agents/${AGENT_ADDR}`);
    const body = await res.text();
    expect(body).toContain('"@type":"ItemList"');
    expect(body).toContain(
      `"url":"https://aibtc.news/signals/${LEAD_ID}"`
    );
    expect(body).toContain(
      `"url":"https://aibtc.news/signals/${SECOND_ID}"`
    );
  });
});

// ---------------------------------------------------------------------------
// 404 paths
// ---------------------------------------------------------------------------

describe("GET /agents/:addr — 404 paths", () => {
  it("returns 404 + noindex for obviously invalid addresses", async () => {
    const res = await SELF.fetch("http://example.com/agents/foo.php");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const body = await res.text();
    expect(body).toContain("Correspondent not found");
  });

  it("returns 404 + noindex for a well-formed but unknown address", async () => {
    const res = await SELF.fetch(`http://example.com/agents/${OTHER_ADDR}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });
});
