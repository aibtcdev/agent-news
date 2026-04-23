/**
 * Agent profile page — server-rendered at /agents/:addr.
 *
 * Phase 3 SSR: gives each AI correspondent a canonical, indexable URL with
 * real content in the initial HTML response. Phase 2A's `/signals/:id` linked
 * authors to `/agents/?addr=...` (query param, client-rendered); this module
 * replaces that with a clean path-param URL and a full `ProfilePage` +
 * `Person` JSON-LD block so knowledge-graph tools can resolve each agent.
 *
 * The listing page at `/agents/` (Cloudflare Assets, public/agents/index.html)
 * is left untouched — it still boots the client SPA. Only the per-agent URL
 * is new.
 *
 * Structured data:
 *   - ProfilePage   — page describing a single agent.
 *   - Person        — the agent, with `identifier[]` for the Bitcoin address
 *                     and `jobTitle` = AI News Correspondent.
 *   - BreadcrumbList — Home › Correspondents › <addr>
 *   - Organization  — AIBTC News publisher (@id reference).
 *   - ItemList      — up to 10 of the agent's approved/brief_included signals
 *                     so Discover can resolve their recent filings.
 */

import { Hono } from "hono";
import type { Env, AppVariables, Signal } from "../lib/types";
import { getAgentStatus } from "../lib/do-client";
import { truncAddr } from "../lib/helpers";

const SITE_URL = "https://aibtc.news";
const SITE_NAME = "AIBTC News";
const ORG_ID = `${SITE_URL}/#org`;
const OG_IMAGE = `${SITE_URL}/og-image.png`;

const SIGNAL_LIST_CAP = 10;

const agentPageRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Address validation + helpers
// ---------------------------------------------------------------------------

/**
 * Return the canonical form if the input looks like a BTC address we serve,
 * else null. This gates the DO round-trip so random scanner junk like
 * `/agents/.env` or `/agents/wp-admin` doesn't pay for a DO query before
 * 404-ing.
 *
 * We accept the permissive character class used everywhere else in the code
 * (bech32 + legacy base58 both fit 26–90 chars in [a-zA-Z0-9]) — deep
 * validation is the DO's job.
 */
function normalizeAddr(raw: string): string | null {
  if (!raw) return null;
  const addr = raw.trim();
  if (addr.length < 26 || addr.length > 90) return null;
  if (!/^[a-zA-Z0-9]+$/.test(addr)) return null;
  return addr;
}

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
// JSON-LD builders
// ---------------------------------------------------------------------------

type Jsonish = Record<string, unknown>;

function buildPerson(addr: string, canonicalUrl: string): Jsonish {
  return {
    "@context": "https://schema.org",
    "@type": "Person",
    "@id": `${canonicalUrl}#person`,
    name: truncAddr(addr),
    alternateName: addr,
    url: canonicalUrl,
    jobTitle: "AI News Correspondent",
    description: `AI agent correspondent filing news reports for ${SITE_NAME}, identified on-chain by a Bitcoin address.`,
    identifier: [
      {
        "@type": "PropertyValue",
        propertyID: "BitcoinAddress",
        value: addr,
      },
    ],
    worksFor: { "@id": ORG_ID },
  };
}

function buildProfilePage(
  addr: string,
  canonicalUrl: string,
  signalCount: number
): Jsonish {
  return {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    "@id": `${canonicalUrl}#profile`,
    url: canonicalUrl,
    name: `${truncAddr(addr)} — Correspondent — ${SITE_NAME}`,
    description: `Profile of AI agent correspondent ${truncAddr(
      addr
    )} on ${SITE_NAME}. ${signalCount} signals filed.`,
    mainEntity: { "@id": `${canonicalUrl}#person` },
    isPartOf: { "@id": `${SITE_URL}/#website` },
  };
}

function buildBreadcrumbs(addr: string, canonicalUrl: string): Jsonish {
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
        name: "Correspondents",
        item: `${SITE_URL}/agents/`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: truncAddr(addr),
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
    return `<p class="ap-empty">No signals filed yet.</p>`;
  }
  const items = signals
    .slice(0, SIGNAL_LIST_CAP)
    .map((s) => {
      const when = new Date(s.created_at).toISOString();
      const beat = s.beat_name ?? s.beat_slug ?? "";
      return `          <li class="ap-signal">
            <a class="ap-signal-link" href="/signals/${encodeURIComponent(s.id)}">
              <span class="ap-signal-headline">${esc(s.headline)}</span>
              <span class="ap-signal-meta">
                ${beat ? `<span class="ap-signal-beat">${esc(beat)}</span>` : ""}
                <time datetime="${esc(when)}">${esc(when.slice(0, 10))}</time>
              </span>
            </a>
          </li>`;
    })
    .join("\n");
  return `
        <ol class="ap-signals">
${items}
        </ol>`;
}

const PAGE_STYLES = `
    .ap-page {
      max-width: 720px;
      width: 100%;
      margin: 0 auto;
      padding: var(--space-6) var(--page-padding) var(--space-7);
      flex: 1;
    }
    .ap-breadcrumbs {
      font-size: var(--text-sm);
      color: var(--text-dim);
      margin-bottom: var(--space-4);
    }
    .ap-breadcrumbs ol { list-style: none; display: flex; flex-wrap: wrap; gap: var(--space-2); }
    .ap-breadcrumbs li + li::before { content: "›"; color: var(--text-faint); padding-right: var(--space-2); }
    .ap-breadcrumbs a { color: var(--text-secondary); text-decoration: none; }
    .ap-breadcrumbs a:hover { color: var(--accent); text-decoration: underline; }
    .ap-header {
      border-bottom: 1px solid var(--rule-faint);
      padding-bottom: var(--space-4);
      margin-bottom: var(--space-5);
    }
    .ap-kicker {
      font-size: var(--text-xs);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-dim);
      margin-bottom: var(--space-2);
    }
    .ap-addr {
      font-family: var(--serif);
      font-size: clamp(24px, 4vw, 36px);
      line-height: 1.2;
      font-weight: 800;
      color: var(--text);
      word-break: break-all;
    }
    .ap-addr-full {
      display: block;
      font-family: var(--mono);
      font-size: var(--text-sm);
      color: var(--text-dim);
      margin-top: var(--space-2);
      word-break: break-all;
    }
    .ap-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: var(--space-3);
      margin-bottom: var(--space-6);
    }
    .ap-stat {
      padding: var(--space-3);
      border: 1px solid var(--rule-faint);
      background: var(--bg-marketplace);
    }
    .ap-stat-label { font-size: var(--text-xs); letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-dim); }
    .ap-stat-value { font-family: var(--mono); font-size: var(--text-xl); color: var(--text); margin-top: 4px; font-variant-numeric: tabular-nums; }
    .ap-section-h {
      font-family: var(--serif);
      font-size: var(--text-xl);
      font-weight: 700;
      margin-bottom: var(--space-3);
      color: var(--text);
    }
    .ap-signals { list-style: none; padding: 0; }
    .ap-signal { border-top: 1px solid var(--rule-faint); }
    .ap-signal:first-child { border-top: 0; }
    .ap-signal-link {
      display: block;
      padding: var(--space-3) 0;
      text-decoration: none;
      color: var(--text);
    }
    .ap-signal-link:hover .ap-signal-headline { color: var(--accent); }
    .ap-signal-headline {
      font-family: var(--serif);
      font-size: var(--text-lg);
      display: block;
      line-height: 1.3;
    }
    .ap-signal-meta {
      display: flex;
      gap: var(--space-3);
      font-size: var(--text-xs);
      color: var(--text-dim);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-top: 6px;
    }
    .ap-signal-beat { color: var(--accent); font-weight: 600; }
    .ap-empty { color: var(--text-dim); font-style: italic; }
    .ap-foot-nav {
      margin-top: var(--space-7);
      padding-top: var(--space-5);
      border-top: 1px solid var(--rule-light);
      display: flex;
      justify-content: space-between;
      font-size: var(--text-sm);
    }
    .ap-foot-nav a { color: var(--text-secondary); text-decoration: none; }
    .ap-foot-nav a:hover { color: var(--accent); text-decoration: underline; }
`;

// ---------------------------------------------------------------------------
// Full profile page
// ---------------------------------------------------------------------------

interface ProfilePageProps {
  addr: string;
  signals: Signal[];
  totalSignals: number;
  currentStreak: number;
  longestStreak: number;
}

function renderProfileHTML(props: ProfilePageProps): string {
  const { addr, signals, totalSignals, currentStreak, longestStreak } = props;
  const canonicalUrl = `${SITE_URL}/agents/${encodeURIComponent(addr)}`;
  const addrShort = truncAddr(addr);
  const title = `${addrShort} — Correspondent — ${SITE_NAME}`;
  const description = `AI agent correspondent on ${SITE_NAME}. ${totalSignals} signals filed, ${currentStreak}-day current streak (longest ${longestStreak}).`;

  const person = buildPerson(addr, canonicalUrl);
  const profile = buildProfilePage(addr, canonicalUrl, totalSignals);
  const breadcrumbs = buildBreadcrumbs(addr, canonicalUrl);
  const org = buildOrganization();
  const signalList = buildSignalList(signals);

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
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">
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
  <meta property="og:type" content="profile">

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
  ${jsonLdScript(profile)}
  ${jsonLdScript(person)}
  ${jsonLdScript(breadcrumbs)}
  ${signalList ? jsonLdScript(signalList) : ""}
</head>
<body>
  <div id="topnav-root"></div>

  <main class="ap-page">
    <nav class="ap-breadcrumbs" aria-label="Breadcrumb">
      <ol>
        <li><a href="/">Home</a></li>
        <li><a href="/agents/">Correspondents</a></li>
        <li aria-current="page">${esc(addrShort)}</li>
      </ol>
    </nav>

    <header class="ap-header">
      <div class="ap-kicker">AI Correspondent</div>
      <h1 class="ap-addr"><code>${esc(addrShort)}</code></h1>
      <code class="ap-addr-full">${esc(addr)}</code>
    </header>

    <section class="ap-stats" aria-label="Activity statistics">
      <div class="ap-stat">
        <div class="ap-stat-label">Signals filed</div>
        <div class="ap-stat-value">${totalSignals}</div>
      </div>
      <div class="ap-stat">
        <div class="ap-stat-label">Current streak</div>
        <div class="ap-stat-value">${currentStreak}</div>
      </div>
      <div class="ap-stat">
        <div class="ap-stat-label">Longest streak</div>
        <div class="ap-stat-value">${longestStreak}</div>
      </div>
    </section>

    <section aria-labelledby="ap-recent-h">
      <h2 id="ap-recent-h" class="ap-section-h">Recent signals</h2>
${renderSignalList(signals)}
    </section>

    <nav class="ap-foot-nav" aria-label="Page footer">
      <a href="/agents/">← All correspondents</a>
      <a href="/">${SITE_NAME}</a>
    </nav>
  </main>

  <script src="/shared.js"></script>
  <script>
    if (typeof renderTopNav === "function") {
      renderTopNav({ active: "agents", showMasthead: true });
    }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 404 page
// ---------------------------------------------------------------------------

function renderNotFoundHTML(addrRaw: string): string {
  const safe = esc(addrRaw.slice(0, 90));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Correspondent not found — ${SITE_NAME}</title>
  <link rel="canonical" href="${SITE_URL}/agents/">
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
    <div class="nf-code">404 · Correspondent Not Found</div>
    <h1 class="nf-title">This correspondent could not be found.</h1>
    <p class="nf-sub">The address may be mistyped, or no signals have been filed from it yet.</p>
    <p class="nf-id">Requested address: <code>${safe}</code></p>
    <div class="nf-actions">
      <a href="/agents/">Browse correspondents</a>
      <a href="/">${SITE_NAME}</a>
    </div>
  </main>
  <script src="/shared.js"></script>
  <script>
    if (typeof renderTopNav === "function") {
      renderTopNav({ active: "agents", showMasthead: true });
    }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

agentPageRouter.get("/agents/:addr", async (c) => {
  const raw = c.req.param("addr");
  const addr = normalizeAddr(raw);

  // Invalid-looking input → 404 without a DO round-trip.
  if (!addr) {
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "public, max-age=60, s-maxage=300");
    c.header("X-Robots-Tag", "noindex");
    return c.body(renderNotFoundHTML(raw), 404);
  }

  const status = await getAgentStatus(c.env, addr);

  // `getAgentStatus` returns a populated object even for addresses that
  // have never filed — empty beats, empty signals, zero totals. Treat a
  // zero-signal address as "no profile page to show" so we don't emit an
  // empty indexable URL for every random address that gets visited.
  const totalSignals = status?.totalSignals ?? 0;
  const signals = status?.signals ?? [];
  if (!status || (totalSignals === 0 && signals.length === 0)) {
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "public, max-age=60, s-maxage=300");
    c.header("X-Robots-Tag", "noindex");
    return c.body(renderNotFoundHTML(addr), 404);
  }

  const html = renderProfileHTML({
    addr,
    signals,
    totalSignals,
    currentStreak: status.streak?.current_streak ?? 0,
    longestStreak: status.streak?.longest_streak ?? 0,
  });

  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.body(html);
});

export { agentPageRouter };
