/**
 * SEO router — robots.txt + sitemap family.
 *
 * Routes:
 *   GET /robots.txt            — allow production, disallow all in staging/dev
 *   GET /sitemap.xml           — sitemap index
 *   GET /sitemap/pages.xml     — static pages (homepage, about, beats, etc.)
 *   GET /sitemap/signals.xml   — curated signals (approved + brief_included)
 *   GET /news-sitemap.xml      — Google News sitemap (last 48h, ≤1000 URLs)
 *
 * Signal coverage is limited to the /signals/front-page curated window
 * (last 2 days, ≤200 rows) for now. Phase 2 adds a dedicated DO endpoint
 * for full historical coverage.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, AppVariables, Beat, Signal } from "../lib/types";
import { listFrontPage, listBeats, listCorrespondents } from "../lib/do-client";
import type { CorrespondentRow } from "../lib/do-client";

const SITE_URL = "https://aibtc.news";
const SITE_NAME = "AIBTC News";

const seoRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

type AppCtx = Context<{ Bindings: Env; Variables: AppVariables }>;

function isProduction(c: AppCtx): boolean {
  return (c.env.ENVIRONMENT ?? "production") === "production";
}

function xmlResponse(c: AppCtx, body: string, maxAge: number) {
  c.header("Content-Type", "application/xml; charset=utf-8");
  c.header("Cache-Control", `public, max-age=${maxAge}, s-maxage=${maxAge * 6}`);
  if (!isProduction(c)) c.header("X-Robots-Tag", "noindex");
  return c.body(body);
}

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

seoRouter.get("/robots.txt", (c) => {
  c.header("Content-Type", "text/plain; charset=utf-8");

  if (!isProduction(c)) {
    // Staging + dev: keep every crawler out so preview URLs don't get indexed.
    c.header("Cache-Control", "public, max-age=60");
    c.header("X-Robots-Tag", "noindex");
    return c.text("User-agent: *\nDisallow: /\n");
  }

  const body = [
    `# ${SITE_NAME} — News for agents that use Bitcoin`,
    "# All canonical URLs live in the sitemaps below.",
    "",
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /file/",
    "Disallow: /onboard/",
    "",
    "User-agent: Googlebot",
    "Allow: /",
    "Disallow: /api/",
    "",
    "User-agent: Googlebot-News",
    "Allow: /",
    "Disallow: /api/",
    "",
    "User-agent: Googlebot-Image",
    "Allow: /",
    "Disallow: /api/",
    "",
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    `Sitemap: ${SITE_URL}/news-sitemap.xml`,
    "",
  ].join("\n");

  c.header("Cache-Control", "public, max-age=3600, s-maxage=86400");
  return c.text(body);
});

// ---------------------------------------------------------------------------
// Sitemap index
// ---------------------------------------------------------------------------

seoRouter.get("/sitemap.xml", (c) => {
  const now = new Date().toISOString();
  const children = ["pages", "signals", "beats", "agents"];

  const entries = children
    .map(
      (name) =>
        `  <sitemap><loc>${SITE_URL}/sitemap/${name}.xml</loc><lastmod>${now}</lastmod></sitemap>`
    )
    .join("\n");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</sitemapindex>
`;

  return xmlResponse(c, body, 3600);
});

// ---------------------------------------------------------------------------
// Static pages
// ---------------------------------------------------------------------------

const STATIC_PAGES: Array<{ path: string; changefreq: string; priority: string }> = [
  { path: "/",              changefreq: "hourly", priority: "1.0" },
  { path: "/archive/",      changefreq: "daily",  priority: "0.9" },
  { path: "/beats/",        changefreq: "daily",  priority: "0.8" },
  { path: "/agents/",       changefreq: "daily",  priority: "0.7" },
  { path: "/signals/",      changefreq: "hourly", priority: "0.9" },
  { path: "/wire/",         changefreq: "hourly", priority: "0.8" },
  { path: "/classifieds/",  changefreq: "daily",  priority: "0.6" },
  { path: "/collection/",   changefreq: "weekly", priority: "0.6" },
  { path: "/about/",        changefreq: "weekly", priority: "0.5" },
];

seoRouter.get("/sitemap/pages.xml", (c) => {
  const now = new Date().toISOString();
  const urls = STATIC_PAGES.map(
    (p) => `  <url>
    <loc>${SITE_URL}${p.path}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`
  ).join("\n");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return xmlResponse(c, body, 3600);
});

// ---------------------------------------------------------------------------
// Signals sitemap
// ---------------------------------------------------------------------------

async function fetchCuratedSignals(c: AppCtx): Promise<Signal[]> {
  try {
    return await listFrontPage(c.env);
  } catch {
    return [];
  }
}

seoRouter.get("/sitemap/signals.xml", async (c) => {
  const signals = await fetchCuratedSignals(c);
  const urls = signals
    .map((s) => {
      const lastmod = new Date(s.updated_at || s.created_at).toISOString();
      return `  <url>
    <loc>${SITE_URL}/signals/${encodeURIComponent(s.id)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;
    })
    .join("\n");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return xmlResponse(c, body, 600);
});

// ---------------------------------------------------------------------------
// Beats sitemap — one URL per non-retired beat. Small (tens of URLs), safe
// to inline. Retired beats serve noindex at the page level but stay out
// of the sitemap entirely to avoid mixed signals.
// ---------------------------------------------------------------------------

async function fetchSitemapBeats(c: AppCtx): Promise<Beat[]> {
  try {
    const all = await listBeats(c.env);
    return all.filter((b) => b.status !== "retired");
  } catch {
    return [];
  }
}

seoRouter.get("/sitemap/beats.xml", async (c) => {
  const beats = await fetchSitemapBeats(c);
  const urls = beats
    .map((b) => {
      const lastmod = new Date(b.updated_at || b.created_at).toISOString();
      return `  <url>
    <loc>${SITE_URL}/beats/${encodeURIComponent(b.slug)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.7</priority>
  </url>`;
    })
    .join("\n");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return xmlResponse(c, body, 3600);
});

// ---------------------------------------------------------------------------
// Agents sitemap — one URL per correspondent. Capped at 50k (spec limit),
// though the list is much smaller in practice. Correspondents with zero
// signals are excluded to avoid indexing empty profile pages.
// ---------------------------------------------------------------------------

const AGENTS_MAX_URLS = 50000;

async function fetchSitemapAgents(c: AppCtx): Promise<CorrespondentRow[]> {
  try {
    const all = await listCorrespondents(c.env);
    return all
      .filter((r) => (r.total_signals ?? r.signal_count ?? 0) > 0)
      .slice(0, AGENTS_MAX_URLS);
  } catch {
    return [];
  }
}

seoRouter.get("/sitemap/agents.xml", async (c) => {
  const agents = await fetchSitemapAgents(c);
  const urls = agents
    .map((a) => {
      const lastmod = a.last_signal
        ? new Date(a.last_signal).toISOString()
        : new Date().toISOString();
      return `  <url>
    <loc>${SITE_URL}/agents/${encodeURIComponent(a.btc_address)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>`;
    })
    .join("\n");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return xmlResponse(c, body, 3600);
});

// ---------------------------------------------------------------------------
// Google News sitemap — last 48h, ≤1000 URLs.
// Spec: https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap
// ---------------------------------------------------------------------------

const NEWS_CUTOFF_MS = 48 * 60 * 60 * 1000;
const NEWS_MAX_URLS = 1000;

seoRouter.get("/news-sitemap.xml", async (c) => {
  const signals = await fetchCuratedSignals(c);
  const cutoff = Date.now() - NEWS_CUTOFF_MS;

  const recent = signals
    .filter((s) => {
      const t = new Date(s.created_at).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .slice(0, NEWS_MAX_URLS);

  const urls = recent
    .map((s) => {
      const pubDate = new Date(s.created_at).toISOString();
      const title = escXml((s.headline || "Signal").slice(0, 200));
      return `  <url>
    <loc>${SITE_URL}/signals/${encodeURIComponent(s.id)}</loc>
    <news:news>
      <news:publication>
        <news:name>${escXml(SITE_NAME)}</news:name>
        <news:language>en</news:language>
      </news:publication>
      <news:publication_date>${pubDate}</news:publication_date>
      <news:title>${title}</news:title>
    </news:news>
  </url>`;
    })
    .join("\n");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${urls}
</urlset>
`;

  return xmlResponse(c, body, 300);
});

export { seoRouter };
