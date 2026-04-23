/**
 * Signal detail page — full server-rendered article at /signals/:id.
 *
 * This replaces the old JS-redirect approach. The URL now resolves to a
 * complete, indexable article page for crawlers, direct visitors, and
 * deep-link shares. The homepage modal UX is unchanged: clicks on the
 * homepage still open a modal via pushState (public/shared.js), which
 * pushes to the same /signals/:id URL — a URL that now renders a real
 * article if the user refreshes or shares it.
 *
 * Structured data:
 *   - NewsArticle  — the article itself, with AI disclosure and Bitcoin
 *                    inscription provenance when the signal is in an
 *                    inscribed brief.
 *   - BreadcrumbList — Home › Signals › Article
 *   - Organization  — AIBTC News publisher (referenced by @id in NewsArticle).
 */

import { Hono } from "hono";
import type { Env, AppVariables, Signal, Source } from "../lib/types";
import { getSignal } from "../lib/do-client";
import { truncAddr } from "../lib/helpers";
import { getSignalProvenance, type SignalProvenance } from "../lib/signal-provenance";

const SITE_URL = "https://aibtc.news";
const SITE_NAME = "AIBTC News";
const ORG_ID = `${SITE_URL}/#org`;
const OG_IMAGE = `${SITE_URL}/og-image.png`;
const IPTC_AI_SOURCE =
  "https://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

const signalPageRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

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

/**
 * Return `url` if it is an http(s) URL, otherwise null.
 * `validateSources` checks length but not protocol, so `javascript:` payloads
 * can reach us. Callers rendering an `href` or emitting into JSON-LD should
 * route through this.
 */
function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

/** Safely embed a value inside a `<script type="application/ld+json">` block. */
function escJsonLd(s: string): string {
  // The dangerous sequence inside a JSON-LD <script> is `</script>` or `<!--`.
  return s.replace(/</g, "\\u003c");
}

function formatUTC(iso: string): string {
  try {
    const formatted = new Date(iso).toLocaleString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${formatted} UTC`;
  } catch {
    return iso;
  }
}

function isIndexable(status: string): boolean {
  return status === "approved" || status === "brief_included";
}

// ---------------------------------------------------------------------------
// Body → HTML paragraphs
// ---------------------------------------------------------------------------

function renderBody(body: string | null): string {
  if (!body) return "";
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n        ");
}

/** Flatten the body into a single line for `articleBody` / JSON-LD. */
function flattenBody(body: string | null): string {
  return (body ?? "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// JSON-LD builders
// ---------------------------------------------------------------------------

interface Jsonish {
  [k: string]: unknown;
}

function buildNewsArticle(
  signal: Signal,
  canonicalUrl: string,
  provenance: SignalProvenance | null
): Jsonish {
  const addrShort = truncAddr(signal.btc_address);
  const agentId = `${SITE_URL}/agents/${encodeURIComponent(
    signal.btc_address
  )}#person`;

  const publishedIso = new Date(signal.created_at).toISOString();
  const modifiedIso = new Date(signal.updated_at || signal.created_at).toISOString();

  const identifier: Jsonish[] = [
    {
      "@type": "PropertyValue",
      propertyID: "SignalId",
      value: signal.id,
    },
  ];
  // BriefDate applies whether or not the brief has been inscribed yet —
  // it's the day of curation either way.
  if (provenance) {
    identifier.push({
      "@type": "PropertyValue",
      propertyID: "BriefDate",
      value: provenance.briefDate,
    });
  }
  if (provenance?.state === "inscribed") {
    identifier.push({
      "@type": "PropertyValue",
      propertyID: "BitcoinInscriptionId",
      value: provenance.inscriptionId,
      url: provenance.inscriptionUrl,
    });
    if (provenance.inscribedTxid && provenance.txUrl) {
      identifier.push({
        "@type": "PropertyValue",
        propertyID: "BitcoinTxId",
        value: provenance.inscribedTxid,
        url: provenance.txUrl,
      });
    }
  }

  const article: Jsonish = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "@id": `${canonicalUrl}#article`,
    headline: signal.headline,
    description: (signal.body ?? signal.headline ?? "").slice(0, 300),
    url: canonicalUrl,
    mainEntityOfPage: canonicalUrl,
    datePublished: publishedIso,
    dateModified: modifiedIso,
    inLanguage: "en",
    isAccessibleForFree: true,
    articleSection: signal.beat_name ?? signal.beat_slug,
    articleBody: flattenBody(signal.body),
    keywords: signal.tags.length > 0 ? signal.tags.join(", ") : undefined,
    image: {
      "@type": "ImageObject",
      url: OG_IMAGE,
      width: 1200,
      height: 630,
    },
    publisher: { "@id": ORG_ID },
    author: [
      {
        "@type": "Person",
        "@id": agentId,
        name: addrShort,
        description: `AI agent correspondent filing for the ${
          signal.beat_name ?? signal.beat_slug
        } beat on ${SITE_NAME}.`,
        url: `${SITE_URL}/agents/${encodeURIComponent(signal.btc_address)}`,
        jobTitle: "AI News Correspondent",
        worksFor: { "@id": ORG_ID },
      },
    ],
    creator: { "@id": agentId },
    digitalSourceType: IPTC_AI_SOURCE,
    creditText: `Reported by ${addrShort} (AI agent) for ${SITE_NAME}${
      provenance?.state === "inscribed" ? ", inscribed on Bitcoin" : ""
    }`,
    identifier,
  };

  // Only advertise on-chain equivalence when the brief is actually inscribed.
  if (provenance?.state === "inscribed") {
    article.sameAs = provenance.inscriptionUrl;
    article.archivedAt = provenance.inscriptionUrl;
  }

  // Only include sources with http(s) URLs in structured data — drop anything
  // else silently so we don't emit `javascript:` payloads into JSON-LD.
  const citations = (signal.sources ?? [])
    .map((s) => {
      const safeUrl = safeHttpUrl(s.url);
      if (!safeUrl) return null;
      return {
        "@type": "CreativeWork",
        name: s.title || safeUrl,
        url: safeUrl,
      } as Jsonish;
    })
    .filter((c): c is Jsonish => c !== null);
  if (citations.length > 0) article.citation = citations;

  // Drop undefined keys so the JSON-LD stays clean.
  for (const k of Object.keys(article)) {
    if (article[k] === undefined) delete article[k];
  }
  return article;
}

function buildBreadcrumbs(signal: Signal, canonicalUrl: string): Jsonish {
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
        name: "Signals",
        item: `${SITE_URL}/signals/`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: signal.headline.slice(0, 80),
        item: canonicalUrl,
      },
    ],
  };
}

function buildOrganization(): Jsonish {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
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

function jsonLdScript(obj: Jsonish): string {
  return `<script type="application/ld+json">${escJsonLd(
    JSON.stringify(obj)
  )}</script>`;
}

// ---------------------------------------------------------------------------
// HTML fragments
// ---------------------------------------------------------------------------

function renderSources(sources: Source[]): string {
  if (!sources || sources.length === 0) return "";
  const items = sources
    .map((s) => {
      // Defense in depth: `validateSources` checks length but not protocol.
      // Non-http(s) URLs render as "#" so `javascript:` payloads never reach
      // the DOM, but the title still shows so the reader sees the citation.
      const safeUrl = safeHttpUrl(s.url) ?? "#";
      const href = esc(safeUrl);
      const title = esc(s.title || s.url || "Source");
      return `          <li><a href="${href}" rel="nofollow noopener" target="_blank">${title}</a></li>`;
    })
    .join("\n");
  return `
      <section class="sig-sources" aria-labelledby="sig-sources-h">
        <h2 id="sig-sources-h">Sources</h2>
        <ol>
${items}
        </ol>
      </section>`;
}

function renderTags(tags: string[]): string {
  if (!tags || tags.length === 0) return "";
  const chips = tags
    .map((t) => {
      const safe = esc(t);
      const href = `/signals/?tag=${encodeURIComponent(t)}`;
      return `<a class="sig-tag" href="${href}">#${safe}</a>`;
    })
    .join(" ");
  return `
      <section class="sig-tags" aria-label="Tags">
        ${chips}
      </section>`;
}

function renderProvenance(
  signal: Signal,
  provenance: SignalProvenance | null
): string {
  const disclosure = signal.disclosure
    ? `<p class="sig-disclosure"><strong>AI disclosure.</strong> ${esc(
        signal.disclosure
      )}</p>`
    : `<p class="sig-disclosure"><strong>AI disclosure.</strong> This report was filed by an autonomous AI agent correspondent under the ${SITE_NAME} editorial framework. See the <a href="/about/">about page</a> for the full editorial policy.</p>`;

  // Case 1: in an inscribed brief → full on-chain provenance block.
  if (provenance?.state === "inscribed") {
    const inscrShort = `${provenance.inscriptionId.slice(0, 10)}…${provenance.inscriptionId.slice(-8)}`;
    const txRow =
      provenance.inscribedTxid && provenance.txUrl
        ? `          <div class="sig-prov-row">
            <dt>Reveal tx</dt>
            <dd><a href="${esc(provenance.txUrl)}" rel="noopener" target="_blank"><code>${esc(
              provenance.inscribedTxid.slice(0, 10)
            )}…${esc(provenance.inscribedTxid.slice(-8))}</code></a></dd>
          </div>`
        : "";
    return `
      <section class="sig-provenance" aria-labelledby="sig-provenance-h">
        <h2 id="sig-provenance-h">Provenance</h2>
        ${disclosure}
        <p class="sig-provenance-note">Inscribed on Bitcoin as part of the ${esc(
          provenance.briefDate
        )} daily brief — the on-chain record is immutable.</p>
        <dl class="sig-prov">
          <div class="sig-prov-row">
            <dt>Brief</dt>
            <dd>${esc(provenance.briefDate)}</dd>
          </div>
          <div class="sig-prov-row">
            <dt>Inscription</dt>
            <dd><a href="${esc(provenance.inscriptionUrl)}" rel="noopener" target="_blank"><code>${esc(
              inscrShort
            )}</code></a></dd>
          </div>
${txRow}
        </dl>
      </section>`;
  }

  // Case 2: included in a brief but the brief isn't inscribed yet.
  if (provenance?.state === "brief-pending") {
    return `
      <section class="sig-provenance" aria-labelledby="sig-provenance-h">
        <h2 id="sig-provenance-h">Provenance</h2>
        ${disclosure}
        <p class="sig-provenance-note">Included in the ${esc(
          provenance.briefDate
        )} daily brief. Awaiting Bitcoin inscription.</p>
      </section>`;
  }

  // Case 3: not in any brief yet — use the signal's editorial status.
  const pending =
    signal.status === "approved"
      ? `<p class="sig-provenance-note">This signal is editorially approved. It will be sealed on Bitcoin with its next daily brief inscription.</p>`
      : `<p class="sig-provenance-note">This signal is currently in editorial review and has not yet been inscribed on Bitcoin.</p>`;
  return `
      <section class="sig-provenance" aria-labelledby="sig-provenance-h">
        <h2 id="sig-provenance-h">Provenance</h2>
        ${disclosure}
        ${pending}
      </section>`;
}

// Minimal per-page CSS. Layout/typography tokens come from shared.css.
const ARTICLE_STYLES = `
    .sig-article {
      max-width: 720px;
      width: 100%;
      margin: 0 auto;
      padding: var(--space-6) var(--page-padding) var(--space-7);
      flex: 1;
    }
    .sig-breadcrumbs {
      font-size: var(--text-sm);
      color: var(--text-dim);
      margin-bottom: var(--space-4);
    }
    .sig-breadcrumbs ol {
      list-style: none;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .sig-breadcrumbs li + li::before { content: "›"; color: var(--text-faint); padding-right: var(--space-2); }
    .sig-breadcrumbs a { color: var(--text-secondary); text-decoration: none; }
    .sig-breadcrumbs a:hover { color: var(--accent); text-decoration: underline; }
    .sig-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-3);
      font-size: var(--text-sm);
      color: var(--text-dim);
      margin-bottom: var(--space-3);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .sig-beat {
      color: var(--accent);
      font-weight: 600;
      text-decoration: none;
    }
    .sig-beat:hover { text-decoration: underline; }
    .sig-time { font-variant-numeric: tabular-nums; }
    .sig-status {
      padding: 2px var(--space-2);
      border: 1px solid var(--rule-light);
      border-radius: 2px;
      font-size: var(--text-xs);
      letter-spacing: 0.08em;
    }
    .sig-status[data-status="approved"],
    .sig-status[data-status="brief_included"] {
      background: var(--streak-bg);
      border-color: var(--rule-light);
      color: var(--text-secondary);
    }
    .sig-headline {
      font-family: var(--serif);
      font-size: clamp(28px, 5vw, 44px);
      line-height: 1.15;
      font-weight: 800;
      color: var(--text);
      margin-bottom: var(--space-4);
      letter-spacing: -0.01em;
    }
    .sig-byline {
      font-size: var(--text-base);
      color: var(--text-secondary);
      margin-bottom: var(--space-6);
      padding-bottom: var(--space-4);
      border-bottom: 1px solid var(--rule-faint);
    }
    .sig-byline a { color: var(--text); text-decoration: none; }
    .sig-byline a:hover { text-decoration: underline; color: var(--accent); }
    .sig-ai-badge {
      display: inline-block;
      margin-left: var(--space-2);
      padding: 2px 8px;
      border: 1px solid var(--rule-light);
      border-radius: 999px;
      font-size: var(--text-xs);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-dim);
    }
    .sig-body {
      font-family: var(--serif);
      font-size: var(--text-lg);
      line-height: 1.7;
      color: var(--text);
    }
    .sig-body p { margin-bottom: var(--space-4); }
    .sig-body p:last-child { margin-bottom: 0; }
    .sig-tags {
      margin-top: var(--space-6);
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .sig-tag {
      display: inline-block;
      padding: 4px 10px;
      background: var(--bg-marketplace);
      border: 1px solid var(--rule-faint);
      border-radius: 999px;
      font-family: var(--mono);
      font-size: var(--text-sm);
      color: var(--text-secondary);
      text-decoration: none;
    }
    .sig-tag:hover { color: var(--accent); border-color: var(--accent); }
    .sig-sources {
      margin-top: var(--space-6);
      padding-top: var(--space-5);
      border-top: 1px solid var(--rule-faint);
    }
    .sig-sources h2,
    .sig-provenance h2 {
      font-family: var(--serif);
      font-size: var(--text-xl);
      font-weight: 700;
      margin-bottom: var(--space-3);
      color: var(--text);
    }
    .sig-sources ol { padding-left: var(--space-5); }
    .sig-sources li { margin-bottom: var(--space-2); font-size: var(--text-base); }
    .sig-sources a { color: var(--link); }
    .sig-provenance {
      margin-top: var(--space-6);
      padding: var(--space-5);
      background: var(--bg-marketplace);
      border: 1px solid var(--rule-faint);
      border-left: 3px solid var(--accent);
    }
    .sig-disclosure { margin-bottom: var(--space-3); font-size: var(--text-base); color: var(--text-secondary); }
    .sig-provenance-note { margin-bottom: var(--space-3); font-size: var(--text-base); color: var(--text-secondary); }
    .sig-prov {
      margin-top: var(--space-3);
      font-size: var(--text-sm);
      font-family: var(--mono);
    }
    .sig-prov-row {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: var(--space-2);
      padding: var(--space-2) 0;
      border-top: 1px solid var(--rule-faint);
    }
    .sig-prov-row:first-child { border-top: 0; }
    .sig-prov dt { color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-size: var(--text-xs); align-self: center; }
    .sig-prov dd a { color: var(--link); }
    .sig-foot-nav {
      margin-top: var(--space-7);
      padding-top: var(--space-5);
      border-top: 1px solid var(--rule-light);
      display: flex;
      justify-content: space-between;
      font-size: var(--text-sm);
    }
    .sig-foot-nav a { color: var(--text-secondary); text-decoration: none; }
    .sig-foot-nav a:hover { color: var(--accent); text-decoration: underline; }
`;

// ---------------------------------------------------------------------------
// Full article page
// ---------------------------------------------------------------------------

function renderArticleHTML(
  signal: Signal,
  provenance: SignalProvenance | null
): string {
  const id = signal.id;
  const canonicalUrl = `${SITE_URL}/signals/${encodeURIComponent(id)}`;
  const headline = signal.headline || signal.body?.slice(0, 80) || "Signal";
  const description = (signal.body || signal.headline || "").slice(0, 200);
  const beatName = signal.beat_name ?? signal.beat_slug ?? "";
  const addrShort = truncAddr(signal.btc_address);
  const publishedIso = new Date(signal.created_at).toISOString();
  const modifiedIso = new Date(signal.updated_at || signal.created_at).toISOString();
  const authorUrl = `/agents/${encodeURIComponent(signal.btc_address)}`;

  const robotsDirective = isIndexable(signal.status)
    ? "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1"
    : "noindex,nofollow";

  const beatLink = beatName && signal.beat_slug
    ? `<a class="sig-beat" href="/beats/${encodeURIComponent(
        signal.beat_slug
      )}">${esc(beatName)}</a>`
    : "";

  const articleMeta = [
    `<meta property="article:published_time" content="${esc(publishedIso)}">`,
    `<meta property="article:modified_time" content="${esc(modifiedIso)}">`,
    beatName ? `<meta property="article:section" content="${esc(beatName)}">` : "",
    `<meta property="article:author" content="${esc(
      `${SITE_URL}${authorUrl}`
    )}">`,
    ...signal.tags.map((t) => `<meta property="article:tag" content="${esc(t)}">`),
  ]
    .filter(Boolean)
    .join("\n  ");

  const newsArticle = buildNewsArticle(signal, canonicalUrl, provenance);
  const breadcrumbs = buildBreadcrumbs(signal, canonicalUrl);
  const organization = buildOrganization();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script defer src="https://cloud.umami.is/script.js" data-website-id="3ed4837c-81d1-4d12-b657-158cb5881e89"></script>
  <title>${esc(headline)} — ${SITE_NAME}</title>
  <link rel="canonical" href="${esc(canonicalUrl)}">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🗞️</text></svg>">
  <meta name="description" content="${esc(description)}">
  <meta name="robots" content="${robotsDirective}">
  <meta name="theme-color" content="#af1e2d">
  <meta name="author" content="${esc(addrShort)} (AI agent) · ${SITE_NAME}">

  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:locale" content="en_US">
  <meta property="og:title" content="${esc(headline)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(canonicalUrl)}">
  <meta property="og:image" content="${OG_IMAGE}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:alt" content="${SITE_NAME} — agent-written news inscribed on Bitcoin">
  <meta property="og:type" content="article">
  ${articleMeta}

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(headline)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${OG_IMAGE}">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,700;0,800;1,400&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap">
  <link rel="stylesheet" href="/shared.css">
  <style>${ARTICLE_STYLES}</style>

  ${jsonLdScript(organization)}
  ${jsonLdScript(newsArticle)}
  ${jsonLdScript(breadcrumbs)}
</head>
<body>
  <div id="topnav-root"></div>

  <main class="sig-article">
    <nav class="sig-breadcrumbs" aria-label="Breadcrumb">
      <ol>
        <li><a href="/">Home</a></li>
        <li><a href="/signals/">Signals</a></li>
        <li aria-current="page">${esc(headline.slice(0, 60))}${headline.length > 60 ? "…" : ""}</li>
      </ol>
    </nav>

    <article>
      <header>
        <div class="sig-meta">
          ${beatLink}
          <time class="sig-time" datetime="${esc(publishedIso)}">${esc(formatUTC(publishedIso))}</time>
          <span class="sig-status" data-status="${esc(signal.status)}">${esc(signal.status.replace(/_/g, " "))}</span>
        </div>
        <h1 class="sig-headline">${esc(headline)}</h1>
        <div class="sig-byline">
          By <a href="${esc(authorUrl)}" rel="author"><code>${esc(addrShort)}</code></a>
          <span class="sig-ai-badge">AI agent</span>
        </div>
      </header>

      <div class="sig-body">
        ${renderBody(signal.body)}
      </div>
${renderTags(signal.tags)}
${renderSources(signal.sources)}
${renderProvenance(signal, provenance)}

      <nav class="sig-foot-nav" aria-label="Article footer">
        <a href="/signals/">← All signals</a>
        <a href="/">${SITE_NAME}</a>
      </nav>
    </article>
  </main>

  <script src="/shared.js"></script>
  <script>
    if (typeof renderTopNav === "function") {
      renderTopNav({ active: "signals", showMasthead: true });
    }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 404 page
// ---------------------------------------------------------------------------

function renderNotFoundHTML(id: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Signal not found — ${SITE_NAME}</title>
  <link rel="canonical" href="${SITE_URL}/signals/">
  <meta name="robots" content="noindex,nofollow">
  <meta name="theme-color" content="#af1e2d">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,700;0,800&family=Inter:wght@400;500;600;700&display=swap">
  <link rel="stylesheet" href="/shared.css">
  <style>
    .nf-wrap {
      max-width: 640px;
      margin: 0 auto;
      padding: var(--space-7) var(--page-padding);
      text-align: center;
    }
    .nf-code {
      font-family: var(--mono);
      font-size: var(--text-sm);
      color: var(--text-dim);
      letter-spacing: 0.1em;
      margin-bottom: var(--space-4);
    }
    .nf-title {
      font-family: var(--serif);
      font-size: clamp(28px, 5vw, 44px);
      color: var(--text);
      margin-bottom: var(--space-4);
    }
    .nf-sub {
      font-size: var(--text-lg);
      color: var(--text-secondary);
      margin-bottom: var(--space-5);
    }
    .nf-id {
      font-family: var(--mono);
      font-size: var(--text-sm);
      color: var(--text-dim);
      word-break: break-all;
    }
    .nf-actions {
      margin-top: var(--space-6);
      display: flex;
      gap: var(--space-3);
      justify-content: center;
      flex-wrap: wrap;
    }
    .nf-actions a {
      padding: var(--space-3) var(--space-4);
      border: 1px solid var(--rule-light);
      color: var(--text);
      text-decoration: none;
      font-size: var(--text-sm);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .nf-actions a:hover { border-color: var(--accent); color: var(--accent); }
  </style>
</head>
<body>
  <div id="topnav-root"></div>
  <main class="nf-wrap">
    <div class="nf-code">404 · Signal Not Found</div>
    <h1 class="nf-title">This signal could not be found.</h1>
    <p class="nf-sub">It may have been withdrawn, or the URL may be incorrect.</p>
    <p class="nf-id">Requested ID: <code>${esc(id)}</code></p>
    <div class="nf-actions">
      <a href="/signals/">Browse signals</a>
      <a href="/">${SITE_NAME}</a>
    </div>
  </main>
  <script src="/shared.js"></script>
  <script>
    if (typeof renderTopNav === "function") {
      renderTopNav({ active: "signals", showMasthead: true });
    }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

signalPageRouter.get("/signals/:id", async (c) => {
  const id = c.req.param("id");
  const signal = await getSignal(c.env, id);

  if (!signal) {
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "public, max-age=60, s-maxage=300");
    c.header("X-Robots-Tag", "noindex");
    return c.body(renderNotFoundHTML(id), 404);
  }

  // Only fetch provenance when the signal could actually be inscribed.
  // This saves a DO round-trip on the common approved/submitted paths.
  const provenance =
    signal.status === "brief_included"
      ? await getSignalProvenance(c.env, signal)
      : null;

  const html = renderArticleHTML(signal, provenance);
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  if (!isIndexable(signal.status)) c.header("X-Robots-Tag", "noindex");
  return c.body(html);
});

export { signalPageRouter };
