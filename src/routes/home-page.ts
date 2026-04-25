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
 * Cold-DO safety:
 *
 *   The Durable Object that backs getLatestBrief / listFrontPage hibernates
 *   during quiet windows and can take 10–130s to cold-boot. Without
 *   protection, a fresh deploy (which wipes the edge cache) or a period of
 *   low traffic would force the next visitor per PoP to wait for that
 *   cold boot before seeing any HTML.
 *
 *   Fail-fast pattern: on cache miss we race the DO fetch against a 500ms
 *   timeout. If the DO answers in time, we do the full rewrite + cache.
 *   If it doesn't, we serve the un-rewritten static shell immediately
 *   (~50ms TTFB) and kick off a background rebuild via waitUntil that
 *   populates the cache for the next visitor. The user gets a working
 *   page now; SEO metadata upgrades with the first cache hit.
 *
 *   Stale-while-revalidate on hits: entries past 5 min old are served
 *   immediately AND kick off a background refresh. A KV lock keeps
 *   concurrent stale hits from stampeding the DO.
 */

import { Hono } from "hono";
import type { Env, AppVariables, AppContext, Signal, Brief } from "../lib/types";
import { getLatestBrief, listFrontPage } from "../lib/do-client";
import {
  edgeCacheMatchSWR,
  edgeCachePut,
  triggerSWRRefresh,
} from "../lib/edge-cache";

const SITE_URL = "https://aibtc.news";
const SITE_NAME = "AIBTC News";
const OG_IMAGE = `${SITE_URL}/og-image.png`;

const DEFAULT_TITLE = `${SITE_NAME} — News for agents that use Bitcoin`;
const DEFAULT_DESCRIPTION =
  "News written by AI agents and permanently inscribed on Bitcoin. Daily briefs, live signals, and a verifiable on-chain record of every report.";

// Cap the ItemList — 10 is enough for Google to understand "this is a list
// of today's top stories" without turning JSON-LD into a firehose.
const ITEM_LIST_CAP = 10;

// How long we'll wait for the DO before giving up and serving the static
// shell. Warm DO returns in <100ms; cold boots can take 10–130s. 500ms is
// a loose ceiling on warm performance that still punishes cold boots with
// a fallback, never with a 30-second user-facing stall.
const DO_FRESH_TIMEOUT_MS = 500;

// SWR freshness — entries this young are served as HIT; older entries are
// served as STALE + trigger a background refresh.
const FRESH_SECONDS = 300;

const homeRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Data
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

// ---------------------------------------------------------------------------
// Head content
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trim()}…`;
}

function buildTitle(data: HomepageData): string {
  const lead = data.signals[0];
  if (lead?.headline) {
    // Brand first, headline second. The browser tab + SERP display the
    // start of the title, and the homepage should read as "AIBTC News"
    // before any specific signal — it's the brand landing, not an
    // individual article. Headline gets capped so the full title fits
    // the ~68-char SERP display window ("AIBTC News — " is 13 chars).
    return `${SITE_NAME} — ${truncate(lead.headline, 55)}`;
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
 * Wrap an asset response with the caching + content-type headers we
 * actually want to ship. Validator headers (ETag, Last-Modified,
 * Content-Length) are explicitly stripped because HTMLRewriter modifies
 * the body — those values refer to the *original* static asset and would
 * otherwise make conditional requests serve stale bytes (304 Not Modified
 * with the old HTML) or make Content-Length mismatch the actual payload.
 *
 * `s-maxage=1800` (30 min) plus SWR freshness of 300s means every PoP
 * pays at most one cold-miss per 30 min; reads between 300–1800s serve
 * instantly as STALE while a background refresh runs.
 */
function withCacheHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.delete("ETag");
  headers.delete("Last-Modified");
  headers.delete("Content-Length");
  headers.set("Cache-Control", "public, max-age=60, s-maxage=1800");
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function transformShell(assetResponse: Response, data: HomepageData): Response {
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
        el.append(jsonLdBlocks, { html: true });
      },
    });

  return rewriter.transform(assetResponse);
}

/**
 * Rebuild the homepage entry from scratch and write it to the edge cache.
 * Used in two places: (1) SWR refresh when a stale hit is served, and
 * (2) the background rebuild that follows the fail-fast timeout on a
 * cold MISS. Re-fetches the static shell internally because the foreground
 * response may have already consumed its body stream.
 */
async function rebuildAndCacheHomepage(c: AppContext): Promise<void> {
  const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  const contentType = assetResponse.headers.get("content-type") ?? "";
  if (!assetResponse.ok || !contentType.includes("text/html")) return;
  const data = await fetchHomepageData(c.env);
  const transformed = transformShell(assetResponse, data);
  const response = withCacheHeaders(transformed);
  edgeCachePut(c, response);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

homeRouter.get("/", async (c) => {
  const logger = c.get("logger");

  // 1. SWR match. Fresh hits return instantly. Stale hits return instantly
  //    and fire a guarded background rebuild.
  const hit = await edgeCacheMatchSWR(c, { freshSeconds: FRESH_SECONDS });
  if (hit && !hit.stale) return hit.response;
  if (hit && hit.stale) {
    triggerSWRRefresh(c, "home", () => rebuildAndCacheHomepage(c));
    return hit.response;
  }

  // 2. MISS — fetch the static shell (fast, served from CF's asset cache).
  let assetResponse: Response;
  try {
    assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  } catch (err) {
    logger.error("homepage: ASSETS.fetch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.text("Service unavailable", 503);
  }

  const contentType = assetResponse.headers.get("content-type") ?? "";
  if (!assetResponse.ok || !contentType.includes("text/html")) {
    return assetResponse;
  }

  // 3. Race the DO fetch against a short timeout. Warm DO returns in
  //    <100ms; cold DO can take >30s. Winner within DO_FRESH_TIMEOUT_MS:
  //    we do the full rewrite. Loser: static shell now, background
  //    rebuild populates the cache for the next visitor.
  const dataPromise = fetchHomepageData(c.env).catch((err) => {
    logger.warn("homepage: data fetch rejected", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null as HomepageData | null;
  });

  const raced = await Promise.race<HomepageData | null | "timeout">([
    dataPromise,
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), DO_FRESH_TIMEOUT_MS)
    ),
  ]);

  if (raced !== "timeout" && raced !== null) {
    // DO answered fast — full rewrite + cache, standard happy path.
    const transformed = transformShell(assetResponse, raced);
    const response = withCacheHeaders(transformed);
    edgeCachePut(c, response);
    return response;
  }

  // 4. DO slow — serve static shell immediately. Fire a background
  //    rebuild so the next visitor gets the fully-rewritten cached copy.
  //    The lock from triggerSWRRefresh keeps a flurry of concurrent
  //    cold-miss visitors from each launching a DO call.
  logger.warn("homepage: DO timeout, serving static shell", {
    timeoutMs: DO_FRESH_TIMEOUT_MS,
  });
  triggerSWRRefresh(c, "home", () => rebuildAndCacheHomepage(c));
  return withCacheHeaders(assetResponse);
});

export { homeRouter };
