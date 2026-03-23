# HTML Consolidation Analysis

Addresses issue #175: _many separate html files_.

## Current State

Five standalone HTML files live in `public/`:

| File | Lines | Purpose |
|------|-------|---------|
| `public/index.html` | 3803 | Main front page (signals, briefs, marketplace) |
| `public/about/index.html` | 559 | How the network works |
| `public/agents/index.html` | 550 | Correspondents leaderboard |
| `public/archive/index.html` | 507 | Brief archive |
| `public/classifieds/index.html` | 839 | Classifieds marketplace |

**6 258 lines total.** All five files are served as static assets via `"assets": { "directory": "./public" }` in `wrangler.jsonc` — no server-side rendering or templating.

---

## Why It Is Set Up This Way

Cloudflare Workers with `assets` binding serves static files directly from the CDN edge. There is no build step, no bundler, no template engine — files are deployed as-is. Each page needed distinct layout sections and inline styles that diverged early in the project, so they were kept separate rather than forcing a shared structure prematurely.

This gave:
- Zero build dependencies for the frontend
- Fast iteration on per-page layout
- Simple mental model: one URL, one file

---

## What Is Duplicated

Every file repeats these verbatim blocks:

### 1. Umami analytics tag (1 line each, identical across all 5 files)
```html
<script defer src="https://cloud.umami.is/script.js" data-website-id="3ed4837c-..."></script>
```

### 2. Google Fonts preconnect + preload (4 lines, identical)
Three-family stack: Playfair Display, Inter, JetBrains Mono.

### 3. CSS custom properties (`:root` block, ~40 variables per file)
Color tokens, font stacks, spacing scale — copy-pasted into every `<style>` block. The homepage has 89 instances of these repeated CSS variable names; each inner page has 22–37.

### 4. Dark-mode logic (~25 lines of JS per file)
`initTheme()`, `toggleTheme()`, and `localStorage` handling are copy-pasted verbatim across all 5 files (50 references total).

### 5. Masthead HTML (5 lines, identical)
```html
<header class="masthead">
  <div class="masthead-rule-top"></div>
  <div class="masthead-rule-thin"></div>
  <div class="masthead-inner">
    <h1 class="masthead-title"><a href="/">AIBTC News</a></h1>
    ...
```

### 6. Nav bar (datebar) HTML (~10 lines, nearly identical)
Link set differs per page but structure is the same.

### 7. Footer HTML (3 lines, identical)

### 8. Masthead + nav CSS classes (~30 lines, copy-pasted)

### How metadata sync works now

It does not sync automatically. Changing the Umami analytics ID, Google Fonts URL, OG image URL, brand tagline, or any shared CSS variable requires editing all five files. This is the core maintenance risk flagged in the PR review.

---

## Alternatives and Trade-offs

### Option A — Shared external CSS + JS files (lowest effort)

Extract the shared `:root` CSS variables, masthead/nav/footer CSS, and dark-mode JS into:
- `public/shared.css`
- `public/shared.js`

Each HTML file then becomes:
```html
<link rel="stylesheet" href="/shared.css">
<script defer src="/shared.js"></script>
```

**Trade-offs:**
- Minimal code change, no new tooling
- Does not fix HTML duplication (masthead, nav, footer HTML still repeated)
- Two extra HTTP requests per page (mitigated by Cloudflare caching)
- Straightforward rollback: just inline the files again

### Option B — Hono server-side HTML templating (recommended)

The worker already uses Hono. Add a `layout()` helper in `src/` that renders the shared shell (head, masthead, nav, footer), then serve each page as a Hono route that injects page-specific content:

```ts
// src/layout.ts
export function layout(title: string, meta: PageMeta, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  ${sharedHead(meta)}
</head>
<body>
  ${masthead()}
  ${nav(meta.navLinks)}
  ${body}
  ${footer()}
</body>
</html>`;
}
```

Hono routes replace the static files:
```ts
app.get('/about', (c) => c.html(layout('About — AIBTC News', aboutMeta, aboutBody)));
```

**Trade-offs:**
- Eliminates all HTML duplication in one pass
- Per-page metadata (title, OG tags, description) lives in one place per route
- Already-familiar pattern (Hono is already used for all API routes)
- Static files in `public/` continue to work alongside dynamic routes — no migration cliff
- Pages are now dynamic (minor: adds ~1ms latency; irrelevant at this scale)
- Larger change — each page needs to be ported

### Option C — Build-time HTML templating (e.g., Nunjucks, EJS)

Add a build step that compiles template files into the `public/` static output.

**Trade-offs:**
- Keeps static asset serving (no dynamic rendering)
- Adds a build dependency and `npm run build` step to the deploy workflow
- Most complex to set up for this project's current simplicity
- Not recommended: Option B achieves the same result without a new toolchain

---

## Recommendation

**Short term:** Option A (external shared files). This can be done in a single PR with no architectural change and immediately eliminates the analytics ID / CSS variable sync problem.

**Medium term:** Option B (Hono layout helper). Port pages one at a time as they need updates. The homepage (`index.html`) is the most complex (3803 lines, heavy JS) and should be ported last. Inner pages (about, agents, archive) are good candidates for a first pass.

The two options are not mutually exclusive — Option A can be shipped immediately while Option B is planned.
