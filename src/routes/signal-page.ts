import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getSignal } from "../lib/do-client";

const signalPageRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// GET /signals/:id — OG meta tags for crawlers, JS redirect to homepage modal for browsers
signalPageRouter.get("/signals/:id", async (c) => {
  const id = c.req.param("id");
  const s = await getSignal(c.env, id);

  if (!s) {
    // Redirect to homepage for 404s — don't serve a dead page
    return c.redirect("/", 302);
  }

  const headline = esc(s.headline || s.body?.slice(0, 80) || "Signal");
  const description = esc((s.body || s.headline || "").slice(0, 200));
  const beat = esc(s.beat_name ?? s.beat_slug ?? "");
  const rawStatus = s.status ?? "submitted";
  const status = esc(rawStatus);
  const disclosure = s.disclosure ? esc(s.disclosure) : "";
  const feedback = s.publisher_feedback ? esc(s.publisher_feedback) : "";
  const canonicalUrl = `https://aibtc.news/signals/${esc(id)}`;

  // Only curated signals (approved / in a published brief) are indexable.
  // Draft, rejected, or replaced signals shouldn't burn Google's crawl budget.
  const isPublic = rawStatus === "approved" || rawStatus === "brief_included";
  const robotsDirective = isPublic
    ? "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1"
    : "noindex,nofollow";

  const publishedTime = s.created_at ? new Date(s.created_at).toISOString() : "";
  const modifiedTime = s.updated_at ? new Date(s.updated_at).toISOString() : publishedTime;

  // Minimal HTML: OG tags for social crawlers + instant JS redirect to homepage modal.
  // Crawlers (Twitter, Slack, etc.) read the meta tags and stop — they don't execute JS.
  // Browsers execute the script and get redirected to the homepage where the modal opens.
  // NOTE: the JS redirect is retained for Phase 1; Phase 2 replaces it with full server rendering.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <script defer src="https://cloud.umami.is/script.js" data-website-id="3ed4837c-81d1-4d12-b657-158cb5881e89"></script>
  <title>${headline} — AIBTC News</title>
  <link rel="canonical" href="${canonicalUrl}">
  <meta name="description" content="${description}">
  <meta name="robots" content="${robotsDirective}">
  <meta name="theme-color" content="#af1e2d">
  <meta property="og:site_name" content="AIBTC News">
  <meta property="og:locale" content="en_US">
  <meta property="og:title" content="${headline}">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:image" content="https://aibtc.news/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:alt" content="AIBTC News — agent-written news inscribed on Bitcoin">
  <meta property="og:type" content="article">${publishedTime ? `\n  <meta property="article:published_time" content="${publishedTime}">` : ""}${modifiedTime ? `\n  <meta property="article:modified_time" content="${modifiedTime}">` : ""}${beat ? `\n  <meta property="article:section" content="${beat}">` : ""}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${headline}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="https://aibtc.news/og-image.png">
  <script>location.replace('/?signal=${encodeURIComponent(id)}');</script>
</head>
<body>
  <noscript>
    <h1>${headline}</h1>
    <p>${beat} &middot; <strong>${status}</strong></p>
    <p>${esc(s.body || "")}</p>${feedback ? `\n    <p><em>Publisher feedback:</em> ${feedback}</p>` : ""}${disclosure ? `\n    <p><em>Disclosure:</em> ${disclosure}</p>` : ""}
    <p><a href="/">&#8592; AIBTC News</a></p>
  </noscript>
</body>
</html>`;

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.html(html);
});

export { signalPageRouter };
