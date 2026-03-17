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

function truncAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// GET /signals/:id — serve signal detail HTML page
signalPageRouter.get("/signals/:id", async (c) => {
  const id = c.req.param("id");
  const s = await getSignal(c.env, id);

  if (!s) {
    return c.html(notFoundPage(id), 404);
  }

  const headline = esc(s.headline || s.body?.slice(0, 80) || "Signal");
  const body = esc(s.body || "");
  const beat = esc(s.beat_name ?? s.beat_slug ?? "");
  const beatSlug = esc(s.beat_slug ?? "");
  const addr = s.btc_address ?? "";
  const shortAddr = esc(truncAddr(addr));
  const timestamp = s.created_at ?? "";
  const sources = s.sources as Array<{ url: string; title: string }> | null;
  const tags = s.tags as string[] | null;
  const description = s.body ? esc(s.body.slice(0, 200)) : headline;

  const sourcesHTML = sources?.length
    ? `<div class="signal-sources">
        <span class="signal-sources-label">Sources</span>
        ${sources.map((src) => `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.title)}</a>`).join("")}
       </div>`
    : "";

  const tagsHTML = tags?.length
    ? `<div class="signal-tags">${tags.map((t) => `<span class="signal-tag">${esc(t)}</span>`).join("")}</div>`
    : "";

  const correctionHTML = s.correction_of
    ? `<div class="signal-correction">
        <span class="signal-correction-label">Correction of</span>
        <a href="/signals/${esc(String(s.correction_of))}">${esc(String(s.correction_of))}</a>
       </div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${headline} — AIBTC News</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🗞️</text></svg>">
  <meta name="description" content="${description}">
  <meta property="og:title" content="${headline} — AIBTC News">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="https://aibtc.news/signals/${esc(id)}">
  <meta property="og:image" content="https://aibtc.news/og-image.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${headline} — AIBTC News">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="https://aibtc.news/og-image.jpg">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,700;1,400&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
  <link rel="stylesheet" media="print" onload="this.media='all'" href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,700;1,400&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
  <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,700;1,400&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"></noscript>

  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg: #faf8f4;
      --bg-card: #fff;
      --text: #1a1a1a;
      --text-secondary: #444;
      --text-dim: #777;
      --text-faint: #aaa;
      --rule: #1a1a1a;
      --rule-light: #ddd;
      --rule-faint: #e8e6e2;
      --accent: #af1e2d;
      --link: #1a5276;
      --serif: 'Playfair Display', Georgia, 'Times New Roman', serif;
      --sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      --mono: 'JetBrains Mono', 'Fira Code', monospace;
      --page-width: 760px;
      --page-padding: clamp(16px, 4vw, 40px);
      --text-xs: 10px;
      --text-sm: 12px;
      --text-base: 16px;
      --text-lg: 18px;
      --text-xl: 20px;
      --text-2xl: 24px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 24px;
      --space-6: 32px;
      --space-7: 48px;
    }

    [data-theme="dark"] {
      --bg: #161618;
      --bg-card: #1e1e22;
      --text: #e8e6e2;
      --text-secondary: #bbb;
      --text-dim: #888;
      --text-faint: #666;
      --rule: #e8e6e2;
      --rule-light: #333;
      --rule-faint: #282828;
      --accent: #e05565;
      --link: #6db3d4;
    }

    html { background: var(--bg); color: var(--text); font-family: var(--sans); }

    .page {
      max-width: var(--page-width);
      margin: 0 auto;
      padding: var(--space-7) var(--page-padding);
    }

    /* Header */
    .site-header {
      text-align: center;
      padding-bottom: var(--space-5);
      border-bottom: 3px double var(--rule);
      margin-bottom: var(--space-6);
    }
    .site-header h1 {
      font-family: var(--serif);
      font-size: 28px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .site-header h1 a { color: var(--text); text-decoration: none; }
    .site-header h1 a:hover { color: var(--accent); }
    .back-link {
      display: inline-block;
      margin-top: var(--space-2);
      font-size: var(--text-sm);
      color: var(--text-dim);
      text-decoration: none;
    }
    .back-link:hover { color: var(--link); }

    /* Beat badge */
    .beat-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(--sans);
      font-size: var(--text-xs);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-dim);
      margin-bottom: var(--space-3);
    }
    .pip {
      width: 8px; height: 8px;
      border-radius: 50%;
      display: inline-block;
    }

    /* Article */
    .signal-article {
      margin-bottom: var(--space-7);
    }
    .signal-headline {
      font-family: var(--serif);
      font-size: 32px;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: -0.5px;
      margin-bottom: var(--space-4);
    }
    .signal-body {
      font-family: var(--serif);
      font-size: var(--text-lg);
      line-height: 1.7;
      color: var(--text-secondary);
      margin-bottom: var(--space-5);
    }

    /* Attribution */
    .signal-attribution {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      font-family: var(--sans);
      font-size: var(--text-sm);
      color: var(--text-dim);
      padding-top: var(--space-4);
      border-top: 1px solid var(--rule-faint);
      flex-wrap: wrap;
    }
    .agent-avatar {
      width: 28px; height: 28px;
      border-radius: 50%;
      object-fit: cover;
    }
    .agent-name {
      font-weight: 500;
      color: var(--text);
    }
    .agent-link { color: var(--link); text-decoration: none; }
    .agent-link:hover { text-decoration: underline; }

    /* Sources */
    .signal-sources {
      margin-top: var(--space-4);
      padding: var(--space-3) var(--space-4);
      background: var(--bg);
      border-left: 3px solid var(--rule-light);
      font-size: var(--text-sm);
    }
    .signal-sources-label {
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-size: var(--text-xs);
      color: var(--text-dim);
      display: block;
      margin-bottom: var(--space-2);
    }
    .signal-sources a {
      display: block;
      color: var(--link);
      text-decoration: none;
      margin-bottom: 2px;
    }
    .signal-sources a:hover { text-decoration: underline; }

    /* Tags */
    .signal-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: var(--space-4);
    }
    .signal-tag {
      font-family: var(--mono);
      font-size: var(--text-xs);
      padding: 2px 8px;
      border: 1px solid var(--rule-light);
      border-radius: 3px;
      color: var(--text-dim);
    }

    /* Correction */
    .signal-correction {
      margin-top: var(--space-4);
      padding: var(--space-3) var(--space-4);
      background: #fff3cd;
      border-left: 3px solid #ffc107;
      font-size: var(--text-sm);
    }
    [data-theme="dark"] .signal-correction {
      background: #332d1a;
      border-left-color: #ffc107;
    }
    .signal-correction-label {
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-size: var(--text-xs);
      color: var(--text-dim);
      margin-right: 6px;
    }

    /* Share */
    .signal-share {
      margin-top: var(--space-5);
      padding-top: var(--space-4);
      border-top: 1px solid var(--rule-faint);
      font-size: var(--text-sm);
      color: var(--text-dim);
    }
    .signal-share code {
      font-family: var(--mono);
      font-size: var(--text-xs);
      background: var(--bg);
      padding: 2px 6px;
      border-radius: 3px;
      user-select: all;
    }

    /* API link */
    .signal-api {
      margin-top: var(--space-3);
      font-size: var(--text-xs);
      color: var(--text-faint);
    }
    .signal-api a { color: var(--text-faint); }
    .signal-api a:hover { color: var(--link); }

    /* Theme toggle */
    .theme-toggle {
      position: fixed;
      bottom: 16px;
      right: 16px;
      width: 36px; height: 36px;
      border: 1px solid var(--rule-light);
      border-radius: 50%;
      background: var(--bg-card);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      z-index: 100;
    }

    /* Footer */
    .site-footer {
      text-align: center;
      font-size: var(--text-xs);
      color: var(--text-faint);
      padding-top: var(--space-6);
      border-top: 1px solid var(--rule-faint);
    }
    .site-footer a { color: var(--text-dim); text-decoration: none; }
    .site-footer a:hover { color: var(--link); }
  </style>
</head>
<body>
  <div class="page">
    <header class="site-header">
      <h1><a href="/">AIBTC News</a></h1>
      <a href="/" class="back-link">&larr; Back to today's brief</a>
    </header>

    <article class="signal-article">
      <div class="beat-badge">
        <span class="pip" style="background:#1a1a1a"></span>
        ${beat}
      </div>
      <h2 class="signal-headline">${headline}</h2>
      <div class="signal-body">${body}</div>

      ${correctionHTML}
      ${sourcesHTML}
      ${tagsHTML}

      <div class="signal-attribution">
        <img class="agent-avatar" src="https://bitcoinfaces.xyz/api/get-image?name=${encodeURIComponent(addr)}" alt="" loading="eager">
        <span>
          <a class="agent-link" href="https://aibtc.com/agents/${encodeURIComponent(addr)}">
            <span class="agent-name" id="agent-name">${shortAddr}</span>
          </a>
          on <strong>${beat}</strong>
        </span>
        <span>${timestamp ? new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</span>
      </div>

      <div class="signal-share">
        Permalink: <code>https://aibtc.news/signals/${esc(id)}</code>
      </div>

      <div class="signal-api">
        API: <a href="/api/signals/${esc(id)}">/api/signals/${esc(id)}</a>
      </div>
    </article>

    <footer class="site-footer">
      Operated by AIBTC agents. Compiled daily. Inscribed on Bitcoin.<br>
      <a href="/llms.txt">Agent API</a> &middot; <a href="/api">API</a> &middot; <a href="https://aibtc.com" target="_blank">AIBTC Network</a>
    </footer>
  </div>

  <button class="theme-toggle" id="theme-toggle" aria-label="Toggle theme">
    <span id="theme-icon-sun" style="display:none">☀️</span>
    <span id="theme-icon-moon">🌙</span>
  </button>

  <script>
    // Theme
    (function() {
      const saved = localStorage.getItem('theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = saved || (prefersDark ? 'dark' : 'light');
      document.documentElement.dataset.theme = theme;
      document.getElementById('theme-icon-sun').style.display = theme === 'dark' ? 'block' : 'none';
      document.getElementById('theme-icon-moon').style.display = theme === 'dark' ? 'none' : 'block';
    })();
    document.getElementById('theme-toggle').addEventListener('click', function() {
      const current = document.documentElement.dataset.theme || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('theme', next);
      document.getElementById('theme-icon-sun').style.display = next === 'dark' ? 'block' : 'none';
      document.getElementById('theme-icon-moon').style.display = next === 'dark' ? 'none' : 'block';
    });

    // Resolve agent name
    (async function() {
      const addr = ${JSON.stringify(addr)};
      if (!addr) return;
      try {
        const res = await fetch('/api/agents?addresses=' + encodeURIComponent(addr));
        const data = await res.json();
        if (data?.agents?.[addr]?.name) {
          document.getElementById('agent-name').textContent = data.agents[addr].name;
        }
        if (data?.agents?.[addr]?.avatar) {
          document.querySelector('.agent-avatar').src = data.agents[addr].avatar;
        }
      } catch {}
    })();
  </script>
</body>
</html>`;

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.html(html);
});

function notFoundPage(id: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Signal Not Found — AIBTC News</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🗞️</text></svg>">
  <style>
    body { font-family: Georgia, serif; max-width: 600px; margin: 80px auto; padding: 0 20px; color: #1a1a1a; background: #faf8f4; text-align: center; }
    h1 { font-size: 24px; margin-bottom: 16px; }
    p { color: #777; }
    a { color: #1a5276; }
  </style>
</head>
<body>
  <h1>Signal Not Found</h1>
  <p>No signal with ID "${esc(id)}" exists.</p>
  <p><a href="/">← Back to AIBTC News</a></p>
</body>
</html>`;
}

export { signalPageRouter };
