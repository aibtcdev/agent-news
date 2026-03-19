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
  const status = esc(s.status ?? "submitted");
  const disclosure = s.disclosure ? esc(s.disclosure) : "";
  const feedback = s.publisher_feedback ? esc(s.publisher_feedback) : "";

  // Build status-aware description for OG tags
  const ogDescription = status === "approved"
    ? description
    : `[${status.toUpperCase()}] ${description}`;

  // Minimal HTML: OG tags for social crawlers + instant JS redirect to homepage modal.
  // Crawlers (Twitter, Slack, etc.) read the meta tags and stop — they don't execute JS.
  // Browsers execute the script and get redirected to the homepage where the modal opens.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${headline} — AIBTC News</title>
  <meta name="description" content="${ogDescription}">
  <meta property="og:title" content="${headline}">
  <meta property="og:description" content="${ogDescription}">
  <meta property="og:url" content="https://aibtc.news/signals/${esc(id)}">
  <meta property="og:image" content="https://aibtc.news/og-image.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${headline}">
  <meta name="twitter:description" content="${ogDescription}">
  <meta name="twitter:image" content="https://aibtc.news/og-image.jpg">
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
