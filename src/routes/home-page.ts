/**
 * Homepage SSR — GET /.
 *
 * The homepage's existing client JS (public/index.html) is a rich SPA that
 * fetches /api/init and paints every surface (brief, ticker, beats, wire).
 * We do NOT want to touch that code path. Instead, this handler transforms
 * the static shell in-flight with HTMLRewriter to inject SEO-grade
 * dynamic metadata + JSON-LD into the initial HTML response, so:
 *
 *   - Google / Discover / Top Stories see real today's content immediately.
 *   - Social cards (Twitter, Slack, Facebook, LinkedIn) render today's
 *     lead headline instead of the generic "News for agents..." fallback.
 *   - Once the client JS boots, it overrides the DOM as usual — users see
 *     the same interactive homepage they always have.
 *
 * Safety model:
 *   1. Fetch shell via env.ASSETS.fetch(). If that fails → 503.
 *   2. Only transform 2xx + text/html responses. 404 / redirects pass through.
 *   3. Fetch brief + signals in parallel with Promise.allSettled so one
 *      slow or failing DO call does not block the other. On total failure,
 *      pass through the untouched asset — SEO takes a hit but UX is fine.
 *   4. HTMLRewriter only targets specific head tags + the closing </head>.
 *      Body DOM / scripts are not touched.
 *   5. Actually cache at the edge via the Workers Cache API (caches.default
 *      through src/lib/edge-cache.ts). `Cache-Control` alone does not
 *      populate the edge cache for Worker responses in this zone — we
 *      have to put-and-match explicitly. Matches the pattern used by
 *      /api/init and /api/beats.
 */

import { Hono } from "hono";
import type { Env, AppVariables, Signal, Brief } from "../lib/types";
import { getLatestBrief, listFrontPage } from "../lib/do-client";
import { edgeCacheMatch, edgeCachePut } from "../lib/edge-cache";

const SITE_URL = "https://aibtc.news";
const SITE_NAME = "AIBTC News";
const OG_IMAGE = `${SITE_URL}/og-image.png`;

const DEFAULT_TITLE = `${SITE_NAME} — News for agents that use Bitcoin`;
const DEFAULT_DESCRIPTION =
  "News written by AI agents and permanently inscribed on Bitcoin. Daily briefs, live signals, and a verifiable on-chain record of every report.";

// Cap the ItemList — 10 is enough for Google to understand "this is a list
// of today's top stories" without turning JSON-LD into a firehose.
const ITEM_LIST_CAP = 10;

const homeRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HomepageData {
  brief: Brief | null;
  signals: Signal[];
}

async function fetchHomepageData(env: Env): Promise<HomepageData> {
  const [briefResult, signalsResult] = await Promise.allSettled([
    getLatestBrief(env),
    listFrontPage(env),
  ]);
  return {
    brief: briefResult.status === "fulfilled" ? briefResult.value : null,
    signals:
      signalsResult.status === "fulfilled" ? signalsResult.value : [],
  };
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trim()}…`;
}

function buildTitle(data: HomepageData): string {
  const lead = data.signals[0];
  if (lead?.headline) {
    // Cap the headline at 55 chars so the full title (+" — AIBTC News")
    // stays under ~68 chars and fits Google's desktop display window
    // (which truncates around 60-65). Longer headlines would otherwise
    // get cut mid-word in SERPs.
    return `${truncate(lead.headline, 55)} — ${SITE_NAME}`;
  }
  return DEFAULT_TITLE;
}

function buildDescription(data: HomepageData): string {
  if (data.brief?.text) return truncate(data.brief.text, 200);
  if (data.signals.length > 0) {
    const top = data.signals
      .slice(0, 3)
      .map((s) => s.headline)
      .join(" · ");
    return truncate(`Today on ${SITE_NAME}: ${top}`, 200);
  }
  return DEFAULT_DESCRIPTION;
}

// ---------------------------------------------------------------------------
// JSON-LD builders
// ---------------------------------------------------------------------------

type Jsonish = Record<string, unknown>;

function buildOrganizationJsonLd(): Jsonish {
  return {
    "@context": "https://schema.org",
    "@type": "NewsMediaOrganization",
    "@id": `${SITE_URL}/#org`,
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    description: DEFAULT_DESCRIPTION,
    logo: {
      "@type": "ImageObject",
      url: OG_IMAGE,
      width: 1200,
      height: 630,
    },
    publishingPrinciples: `${SITE_URL}/about/`,
  };
}

function buildWebsiteJsonLd(): Jsonish {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    publisher: { "@id": `${SITE_URL}/#org` },
    inLanguage: "en",
  };
}

function buildItemListJsonLd(signals: Signal[]): Jsonish | null {
  const trimmed = signals.slice(0, ITEM_LIST_CAP);
  if (trimmed.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${SITE_NAME} — Front Page`,
    numberOfItems: trimmed.length,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    itemListElement: trimmed.map((s, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${SITE_URL}/signals/${encodeURIComponent(s.id)}`,
      name: s.headline,
    })),
  };
}

/** Same `</script>` escape trick we use on signal-page.ts. */
function escJsonLd(s: string): string {
  return s.replace(/</g, "\\u003c");
}

function jsonLdScript(obj: Jsonish): string {
  return `\n  <script type="application/ld+json">${escJsonLd(
    JSON.stringify(obj)
  )}</script>`;
}

function buildJsonLdBlocks(data: HomepageData): string {
  const blocks = [buildOrganizationJsonLd(), buildWebsiteJsonLd()];
  const list = buildItemListJsonLd(data.signals);
  if (list) blocks.push(list);
  return blocks.map(jsonLdScript).join("");
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Rebuild the response with our Cache-Control + text/html content type.
 *
 * Validator headers (ETag, Last-Modified, Content-Length) are explicitly
 * stripped because HTMLRewriter modifies the body — those values refer to
 * the *original* static asset and would otherwise make conditional
 * requests serve stale bytes (304 Not Modified with the old HTML) or
 * make the Content-Length mismatch the actual payload.
 *
 * Cache-Control here is advisory — it tells browsers + downstream caches
 * how long the response is valid. Actual edge caching happens via
 * `edgeCachePut` in the route handler (Workers Cache API), since
 * `Cache-Control` alone doesn't populate the Cloudflare edge cache for
 * Worker responses.
 */
function withCacheHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  // Drop original-asset validators — the transformed body won't match.
  headers.delete("ETag");
  headers.delete("Last-Modified");
  headers.delete("Content-Length");
  headers.set("Cache-Control", "public, max-age=60, s-maxage=300");
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

homeRouter.get("/", async (c) => {
  const logger = c.get("logger");

  // 1. Edge cache short-circuit. Keeps the homepage at <50ms TTFB on
  //    warm hits under load. Cache key is the canonical request URL.
  const cached = await edgeCacheMatch(c);
  if (cached) return cached;

  // 2. Fetch the static shell. If this fails we have nothing to serve.
  let assetResponse: Response;
  try {
    assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  } catch (err) {
    logger.error("homepage: ASSETS.fetch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.text("Service unavailable", 503);
  }

  // 3. Only transform successful HTML responses. Anything else (404,
  //    redirect, binary asset) passes through unmodified.
  const contentType = assetResponse.headers.get("content-type") ?? "";
  if (!assetResponse.ok || !contentType.includes("text/html")) {
    return assetResponse;
  }

  // 4. Fetch dynamic data. `fetchHomepageData` uses Promise.allSettled
  //    internally and degrades to null/empty on per-source failures, so
  //    it cannot reject under normal conditions. The try/catch below is
  //    defensive against *synchronous* throws (e.g. if a DO binding is
  //    ever missing at boot) — rare but cheap to guard.
  let data: HomepageData;
  try {
    data = await fetchHomepageData(c.env);
  } catch (err) {
    logger.warn("homepage: unexpected sync error in data fetch, passing through shell", {
      error: err instanceof Error ? err.message : String(err),
    });
    return withCacheHeaders(assetResponse);
  }

  // 5. Transform the head. Body, scripts, and placeholder divs are not
  //    touched — the client-side boot code runs unchanged.
  const title = buildTitle(data);
  const description = buildDescription(data);
  const jsonLdBlocks = buildJsonLdBlocks(data);

  const setContent = (content: string) => ({
    element(el: Element) {
      el.setAttribute("content", content);
    },
  });

  const rewriter = new HTMLRewriter()
    .on("title", {
      element(el) {
        el.setInnerContent(title);
      },
    })
    .on('meta[name="description"]', setContent(description))
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(description))
    .on('meta[name="twitter:title"]', setContent(title))
    .on('meta[name="twitter:description"]', setContent(description))
    .on("head", {
      element(el) {
        // Append JSON-LD blocks at the end of <head> — after the existing
        // canonical, OG, and stylesheet tags, before the body starts.
        el.append(jsonLdBlocks, { html: true });
      },
    });

  const transformed = rewriter.transform(assetResponse);
  const response = withCacheHeaders(transformed);

  // 6. Store in the edge cache so subsequent hits within s-maxage skip
  //    the ASSETS fetch + DO calls + HTMLRewriter pipeline. edgeCachePut
  //    uses `executionCtx.waitUntil` so we don't pay any latency for the
  //    store. Cache entry at rest doesn't carry the X-Edge-Cache: MISS
  //    marker (only the live response the caller receives does).
  edgeCachePut(c, response);
  return response;
});

export { homeRouter };
