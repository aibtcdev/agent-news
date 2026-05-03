import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * Smoke tests for the SEO router (robots.txt + sitemap family).
 * Verifies routes are wired, return the right content types, and emit
 * the structural markers each response needs to be valid.
 */

describe("GET /robots.txt", () => {
  // Test runtime sets ENVIRONMENT=test (see vitest.config.mts), so robots.txt
  // returns the non-production "disallow everything" body. The production branch
  // (allow + sitemap entries) is exercised by the deployed worker on aibtc.news.
  it("disallows all crawlers in non-production environments", async () => {
    const res = await SELF.fetch("http://example.com/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const body = await res.text();
    expect(body).toMatch(/User-agent:\s*\*/);
    expect(body).toMatch(/Disallow:\s*\//);
  });
});

describe("GET /sitemap.xml", () => {
  it("returns a sitemap index referencing children", async () => {
    const res = await SELF.fetch("http://example.com/sitemap.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/xml/);
    const body = await res.text();
    expect(body).toContain("<sitemapindex");
    expect(body).toContain("https://aibtc.news/sitemap/pages.xml");
    expect(body).toContain("https://aibtc.news/sitemap/signals.xml");
  });
});

describe("GET /sitemap/pages.xml", () => {
  it("lists canonical static URLs", async () => {
    const res = await SELF.fetch("http://example.com/sitemap/pages.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/xml/);
    const body = await res.text();
    expect(body).toContain("<urlset");
    expect(body).toContain("<loc>https://aibtc.news/</loc>");
    expect(body).toContain("<loc>https://aibtc.news/archive/</loc>");
    expect(body).toContain("<loc>https://aibtc.news/beats/</loc>");
  });

  it("does not list operator-only paths", async () => {
    const res = await SELF.fetch("http://example.com/sitemap/pages.xml");
    const body = await res.text();
    expect(body).not.toContain("https://aibtc.news/file/");
    expect(body).not.toContain("https://aibtc.news/onboard/");
  });
});

describe("GET /sitemap/signals.xml", () => {
  it("returns a valid urlset (possibly empty)", async () => {
    const res = await SELF.fetch("http://example.com/sitemap/signals.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/xml/);
    const body = await res.text();
    expect(body).toMatch(/<\?xml\s/);
    expect(body).toContain("<urlset");
    expect(body).toContain("</urlset>");
  });
});

describe("GET /news-sitemap.xml", () => {
  it("declares the news namespace and returns a valid urlset", async () => {
    const res = await SELF.fetch("http://example.com/news-sitemap.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/xml/);
    const body = await res.text();
    expect(body).toContain(
      'xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"'
    );
    expect(body).toContain("<urlset");
    expect(body).toContain("</urlset>");
  });
});
