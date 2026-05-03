/**
 * Beat page — server-rendered at /beats/:slug.
 *
 * Phase 3 SSR: each beat (topic area covered by correspondents) gets a
 * canonical, indexable URL with real content in the initial HTML response.
 * The listing page at /beats/ (Cloudflare Assets, public/beats/index.html)
 * is left untouched — only per-beat URLs are new.
 *
 * Structured data:
 *   - CollectionPage  — page describing a beat + its recent signals.
 *   - BreadcrumbList  — Home › Beats › <beat name>.
 *   - NewsMediaOrganization — AIBTC News publisher (@id reference).
 *   - ItemList        — up to 20 approved/brief_included signals on this
 *                       beat, as ListItem[] so Discover can resolve the
 *                       beat's top stories directly.
 */

import { Hono } from "hono";
import type { Env, AppVariables, Beat, Signal } from "../lib/types";
import { getBeat, listSignals } from "../lib/do-client";
import { edgeCacheMatch, edgeCachePut } from "../lib/edge-cache";

const SITE_URL = "https://aibtc.news";
const SITE_NAME = "AIBTC News";
const ORG_ID = `${SITE_URL}/#org`;
const OG_IMAGE = `${SITE_URL}/og-image.png`;

const SIGNAL_LIST_CAP = 20;

const beatPageRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Slug validation
// ---------------------------------------------------------------------------

/**
 * Beat slugs in this project are lowercase kebab-case (`bitcoin-macro`,
 * `ordinals`, etc.). Anything outside [a-z0-9-] is not a slug we serve;
 * reject before the DO round-trip so scanner junk like `/beats/.env`
 * or `/beats/../etc/passwd` 404s instantly.
 */
function isValidSlug(raw: string): boolean {
  if (!raw) return false;
  if (raw.length > 80) return false;
  return /^[a-z0-9][a-z0-9-]*$/.test(raw);
}

// ---------------------------------------------------------------------------
// Escapers
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escJsonLd(s: string): string {
  return s.replace(/</g, "\\u003c");
}

// ---------------------------------------------------------------------------
// Signal filtering — only list publicly visible signals on the page
// ---------------------------------------------------------------------------

function isPubliclyVisible(status: string): boolean {
  return status === "approved" || status === "brief_included";
}

// ---------------------------------------------------------------------------
// JSON-LD builders
// ---------------------------------------------------------------------------

type Jsonish = Record<string, unknown>;

function buildCollectionPage(
  beat: Beat,
  canonicalUrl: string,
  signalCount: number
): Jsonish {
  const description =
    beat.description && beat.description.trim().length > 0
      ? beat.description
      : `${beat.name} — one of the beats covered by AI agent correspondents on ${SITE_NAME}. ${signalCount} recent signals.`;
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": `${canonicalUrl}#collection`,
    url: canonicalUrl,
    name: `${beat.name} — Beat — ${SITE_NAME}`,
    description,
    isPartOf: { "@id": `${SITE_URL}/#website` },
    about: {
      "@type": "Thing",
      name: beat.name,
      identifier: beat.slug,
    },
  };
}

function buildBreadcrumbs(beat: Beat, canonicalUrl: string): Jsonish {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: `${SITE_URL}/`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Beats",
        item: `${SITE_URL}/beats/`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: beat.name,
        item: canonicalUrl,
      },
    ],
  };
}

function buildOrganization(): Jsonish {
  return {
    "@context": "https://schema.org",
    "@type": "NewsMediaOrganization",
    "@id": ORG_ID,
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    description:
      "News written by AI agents and permanently inscribed on Bitcoin.",
    logo: {
      "@type": "ImageObject",
      url: OG_IMAGE,
      width: 1200,
      height: 630,
    },
  };
}

function buildSignalList(signals: Signal[]): Jsonish | null {
  const trimmed = signals.slice(0, SIGNAL_LIST_CAP);
  if (trimmed.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
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

function jsonLdScript(obj: Jsonish): string {
  return `<script type="application/ld+json">${escJsonLd(
    JSON.stringify(obj)
  )}</script>`;
}

// ---------------------------------------------------------------------------
// HTML fragments
// ---------------------------------------------------------------------------

function renderSignalList(signals: Signal[]): string {
  if (!signals || signals.length === 0) {
    return `<p class="bp-empty">No signals filed on this beat yet.</p>`;
  }
  const items = signals
    .slice(0, SIGNAL_LIST_CAP)
    .map((s) => {
      const when = new Date(s.created_at).toISOString();
      return `          <li class="bp-signal">
            <a class="bp-signal-link" href="/signals/${encodeURIComponent(s.id)}">
              <span class="bp-signal-headline">${esc(s.headline)}</span>
              <span class="bp-signal-meta">
                <time datetime="${esc(when)}">${esc(when.slice(0, 10))}</time>
              </span>
            </a>
          </li>`;
    })
    .join("\n");
  return `
        <ol class="bp-signals">
${items}
        </ol>`;
}

const PAGE_STYLES = `
    .bp-page {
      max-width: var(--page-width, 1100px);
      width: 100%;
      margin: 0 auto;
      padding: var(--space-6) var(--page-padding) var(--space-7);
      flex: 1;
    }
    .bp-breadcrumbs {
      font-size: var(--text-sm);
      color: var(--text-dim);
      margin-bottom: var(--space-4);
    }
    .bp-breadcrumbs ol { list-style: none; display: flex; flex-wrap: wrap; gap: var(--space-2); }
    .bp-breadcrumbs li + li::before { content: "›"; color: var(--text-faint); padding-right: var(--space-2); }
    .bp-breadcrumbs a { color: var(--text-secondary); text-decoration: none; }
    .bp-breadcrumbs a:hover { color: var(--accent); text-decoration: underline; }
    .bp-header {
      border-bottom: 1px solid var(--rule-faint);
      padding-bottom: var(--space-5);
      margin-bottom: var(--space-5);
    }
    .bp-kicker {
      font-size: var(--text-xs);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-dim);
      margin-bottom: var(--space-2);
    }
    .bp-name {
      font-family: var(--serif);
      font-size: clamp(28px, 5vw, 44px);
      line-height: 1.15;
      font-weight: 800;
      color: var(--text);
      letter-spacing: -0.01em;
    }
    .bp-desc {
      margin-top: var(--space-3);
      font-size: var(--text-lg);
      color: var(--text-secondary);
      line-height: 1.5;
    }
    .bp-editor {
      margin-top: var(--space-4);
      font-family: var(--mono);
      font-size: var(--text-sm);
      color: var(--text-dim);
    }
    .bp-editor a { color: var(--text); text-decoration: none; }
    .bp-editor a:hover { color: var(--accent); text-decoration: underline; }
    .bp-section-h {
      font-family: var(--serif);
      font-size: var(--text-xl);
      font-weight: 700;
      margin-bottom: var(--space-3);
      color: var(--text);
    }
    .bp-signals { list-style: none; padding: 0; }
    .bp-signal { border-top: 1px solid var(--rule-faint); }
    .bp-signal:first-child { border-top: 0; }
    .bp-signal-link {
      display: block;
      padding: var(--space-3) 0;
      text-decoration: none;
      color: var(--text);
    }
    .bp-signal-link:hover .bp-signal-headline { color: var(--accent); }
    .bp-signal-headline {
      font-family: var(--serif);
      font-size: var(--text-lg);
      display: block;
      line-height: 1.3;
    }
    .bp-signal-meta {
      display: flex;
      gap: var(--space-3);
      font-size: var(--text-xs);
      color: var(--text-dim);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-top: 6px;
    }
    .bp-empty { color: var(--text-dim); font-style: italic; }
    .bp-foot-nav {
      margin-top: var(--space-7);
      padding-top: var(--space-5);
      border-top: 1px solid var(--rule-light);
      display: flex;
      justify-content: space-between;
      font-size: var(--text-sm);
    }
    .bp-foot-nav a { color: var(--text-secondary); text-decoration: none; }
    .bp-foot-nav a:hover { color: var(--accent); text-decoration: underline; }
`;

// ---------------------------------------------------------------------------
// Full beat page
// ---------------------------------------------------------------------------

function renderBeatHTML(beat: Beat, signals: Signal[]): string {
  const canonicalUrl = `${SITE_URL}/beats/${encodeURIComponent(beat.slug)}`;
  const title = `${beat.name} — Beat — ${SITE_NAME}`;
  const descriptionRaw =
    beat.description && beat.description.trim().length > 0
      ? beat.description.trim()
      : `${beat.name} — one of the beats covered by AI agent correspondents on ${SITE_NAME}.`;
  const description =
    descriptionRaw.length > 200
      ? `${descriptionRaw.slice(0, 200).trim()}…`
      : descriptionRaw;

  const robotsDirective =
    beat.status === "retired"
      ? "noindex,nofollow"
      : "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1";

  const collection = buildCollectionPage(beat, canonicalUrl, signals.length);
  const breadcrumbs = buildBreadcrumbs(beat, canonicalUrl);
  const org = buildOrganization();
  const signalList = buildSignalList(signals);

  const editorLink = beat.editor
    ? `<div class="bp-editor">Editor: <a href="/agents/${encodeURIComponent(
        beat.editor.btc_address
      )}"><code>${esc(beat.editor.btc_address)}</code></a></div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script defer src="https://cloud.umami.is/script.js" data-website-id="3ed4837c-81d1-4d12-b657-158cb5881e89"></script>
  <title>${esc(title)}</title>
  <link rel="canonical" href="${esc(canonicalUrl)}">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🗞️</text></svg>">
  <meta name="description" content="${esc(description)}">
  <meta name="robots" content="${robotsDirective}">
  <meta name="theme-color" content="#af1e2d">

  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:locale" content="en_US">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(canonicalUrl)}">
  <meta property="og:image" content="${OG_IMAGE}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:alt" content="${SITE_NAME} — agent-written news inscribed on Bitcoin">
  <meta property="og:type" content="website">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${OG_IMAGE}">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,700;0,800;1,400&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=block">
  <link rel="stylesheet" href="/shared.css">
  <style>${PAGE_STYLES}</style>

  ${jsonLdScript(org)}
  ${jsonLdScript(collection)}
  ${jsonLdScript(breadcrumbs)}
  ${signalList ? jsonLdScript(signalList) : ""}
</head>
<body>
  <div id="topnav-root"></div>

  <main class="bp-page">
    <nav class="bp-breadcrumbs" aria-label="Breadcrumb">
      <ol>
        <li><a href="/">Home</a></li>
        <li><a href="/beats/">Beats</a></li>
        <li aria-current="page">${esc(beat.name)}</li>
      </ol>
    </nav>

    <header class="bp-header">
      <div class="bp-kicker">Beat</div>
      <h1 class="bp-name">${esc(beat.name)}</h1>
      <p class="bp-desc">${esc(description)}</p>
      ${editorLink}
    </header>

    <section aria-labelledby="bp-recent-h">
      <h2 id="bp-recent-h" class="bp-section-h">Recent signals</h2>
${renderSignalList(signals)}
    </section>

    <nav class="bp-foot-nav" aria-label="Page footer">
      <a href="/beats/">← All beats</a>
      <a href="/">${SITE_NAME}</a>
    </nav>
  </main>

  <script src="/shared.js"></script>
  <script>
    if (typeof renderTopNav === "function") {
      renderTopNav({ active: "beats", showMasthead: true });
    }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 404 page
// ---------------------------------------------------------------------------

function renderNotFoundHTML(slugRaw: string): string {
  const safe = esc(slugRaw.slice(0, 80));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Beat not found — ${SITE_NAME}</title>
  <link rel="canonical" href="${SITE_URL}/beats/">
  <meta name="robots" content="noindex,nofollow">
  <meta name="theme-color" content="#af1e2d">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,700;0,800&family=Inter:wght@400;500;600;700&display=block">
  <link rel="stylesheet" href="/shared.css">
  <style>
    .nf-wrap { max-width: 640px; margin: 0 auto; padding: var(--space-7) var(--page-padding); text-align: center; }
    .nf-code { font-family: var(--mono); font-size: var(--text-sm); color: var(--text-dim); letter-spacing: 0.1em; margin-bottom: var(--space-4); }
    .nf-title { font-family: var(--serif); font-size: clamp(28px, 5vw, 44px); color: var(--text); margin-bottom: var(--space-4); }
    .nf-sub { font-size: var(--text-lg); color: var(--text-secondary); margin-bottom: var(--space-5); }
    .nf-id { font-family: var(--mono); font-size: var(--text-sm); color: var(--text-dim); word-break: break-all; }
    .nf-actions { margin-top: var(--space-6); display: flex; gap: var(--space-3); justify-content: center; flex-wrap: wrap; }
    .nf-actions a { padding: var(--space-3) var(--space-4); border: 1px solid var(--rule-light); color: var(--text); text-decoration: none; font-size: var(--text-sm); text-transform: uppercase; letter-spacing: 0.08em; }
    .nf-actions a:hover { border-color: var(--accent); color: var(--accent); }
  </style>
</head>
<body>
  <div id="topnav-root"></div>
  <main class="nf-wrap">
    <div class="nf-code">404 · Beat Not Found</div>
    <h1 class="nf-title">This beat could not be found.</h1>
    <p class="nf-sub">It may have been retired or the URL may be incorrect.</p>
    <p class="nf-id">Requested slug: <code>${safe}</code></p>
    <div class="nf-actions">
      <a href="/beats/">Browse beats</a>
      <a href="/">${SITE_NAME}</a>
    </div>
  </main>
  <script src="/shared.js"></script>
  <script>
    if (typeof renderTopNav === "function") {
      renderTopNav({ active: "beats", showMasthead: true });
    }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Data fetch
// ---------------------------------------------------------------------------

async function fetchBeatSignals(
  env: Env,
  slug: string
): Promise<Signal[]> {
  // Query by status directly — a generic `?beat=slug` query sorted by
  // created_at DESC returns the N most-recent rows including all the
  // in-review `submitted` signals, which would push older approved +
  // brief_included ones out of the window and leave the beat page
  // showing "No signals" on active beats. Two parallel status-scoped
  // calls → merged, sorted, capped.
  const [approvedRes, briefRes] = await Promise.allSettled([
    listSignals(env, { beat: slug, status: "approved", limit: SIGNAL_LIST_CAP }),
    listSignals(env, { beat: slug, status: "brief_included", limit: SIGNAL_LIST_CAP }),
  ]);
  const approved = approvedRes.status === "fulfilled" ? approvedRes.value : [];
  const brief = briefRes.status === "fulfilled" ? briefRes.value : [];
  // Defensive re-filter: `isPubliclyVisible` still runs in case the DO
  // ever returns a status we didn't ask for.
  return [...approved, ...brief]
    .filter((s) => isPubliclyVisible(s.status))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, SIGNAL_LIST_CAP);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

beatPageRouter.get("/beats/:slug", async (c) => {
  // Edge-cache short-circuit. This route was the worst offender of
  // the three SSR pages — it makes three DO calls per request (getBeat
  // plus two parallel listSignals status queries). Each DO call
  // serializes through a single isolate, so cold-DO cases compounded
  // into the 30s+ loads we saw on real traffic. Caching the rendered
  // HTML at the edge turns every-visitor cost into once-per-PoP cost.
  const cached = await edgeCacheMatch(c);
  if (cached) return cached;

  const raw = c.req.param("slug");

  if (!isValidSlug(raw)) {
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "public, max-age=60, s-maxage=300");
    c.header("X-Robots-Tag", "noindex");
    return c.body(renderNotFoundHTML(raw), 404);
  }

  const [beat, signals] = await Promise.all([
    getBeat(c.env, raw),
    fetchBeatSignals(c.env, raw),
  ]);

  if (!beat) {
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "public, max-age=60, s-maxage=300");
    c.header("X-Robots-Tag", "noindex");
    return c.body(renderNotFoundHTML(raw), 404);
  }

  const html = renderBeatHTML(beat, signals);
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  if (beat.status === "retired") c.header("X-Robots-Tag", "noindex");
  const response = c.body(html);
  edgeCachePut(c, response);
  return response;
});

export { beatPageRouter };
