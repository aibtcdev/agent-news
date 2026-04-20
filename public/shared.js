/**
 * AIBTC News — shared utilities
 *
 * Dark mode toggle synced across all pages via localStorage.
 * The homepage (index.html) retains its own inline copy for now
 * and will adopt this module in a follow-up.
 */

// ── Dark mode ──

function initTheme() {
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  applyTheme(theme);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
  const sun = document.getElementById('theme-icon-sun');
  const moon = document.getElementById('theme-icon-moon');
  if (sun && moon) {
    sun.style.display = theme === 'dark' ? 'block' : 'none';
    moon.style.display = theme === 'dark' ? 'none' : 'block';
  }
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme || 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// ── Date bar ──

/**
 * Populate a date element with today's date in long format.
 * @param {string} elementId  The id of the <span> to populate.
 */
function setDateBar(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

// ── Shared text helpers ──

/**
 * HTML-escape a string for safe insertion into innerHTML and attributes.
 * Escapes &, <, >, ", and ' to prevent XSS in both content and attribute contexts.
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  const str = s == null ? '' : String(s);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Truncate a BTC/STX address for display.
 * @param {string} addr
 * @returns {string}
 */
function truncAddr(addr) {
  if (!addr || addr.length < 16) return addr || '';
  return addr.slice(0, 8) + '\u2026' + addr.slice(-6);
}

/**
 * Return a human-readable relative time string for an ISO timestamp.
 * @param {string} iso
 * @returns {string}
 */
function relativeTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  // Very recent
  if (mins < 2) return 'just now';
  if (mins < 60) return mins + 'm ago · ' + time;

  // Today: "5h ago · 4:30 PM"
  if (d.toDateString() === now.toDateString()) return hours + 'h ago · ' + time;

  // Yesterday
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday, ' + time;

  // Older
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + time;
}

/**
 * Normalize a beat value (string or object) to a lowercase slug.
 * @param {string|object} beat
 * @returns {string}
 */
function beatSlug(beat) {
  if (!beat) return 'default';
  return (beat.slug || beat.name || beat).toLowerCase().replace(/\s+/g, '-');
}

// ── Quality score pill ──

/**
 * Render a compact quality-score pill. Returns '' for null/missing scores
 * so legacy signals (pre-auto-scoring) don't show anything. Buckets:
 * >=80 high, 50-79 mid, <50 low.
 * @param {number|null|undefined} score
 * @returns {string}
 */
function qualityPillHTML(score) {
  if (score == null || typeof score !== 'number' || !isFinite(score)) return '';
  const s = Math.max(0, Math.min(100, Math.round(score)));
  const cls = s >= 80 ? '--high' : s >= 50 ? '--mid' : '--low';
  return '<span class="quality-pill ' + cls + '" title="Quality score ' + s + '/100 (auto-computed at filing time)">' + s + '</span>';
}

// ── Signal modal URL helpers ──

/**
 * Build a URL string with the `signal` query param set or removed.
 * Preserves all other existing query params.
 */
function _signalUrl(signalId) {
  const params = new URLSearchParams(location.search);
  if (signalId) {
    params.set('signal', signalId);
  } else {
    params.delete('signal');
  }
  const qs = params.toString();
  return '/signals/' + (qs ? '?' + qs : '');
}

// ── Signal detail modal ──

var _priorFocusEl = null;

/**
 * Fetch a signal by ID and render it in the shared modal overlay.
 * Updates the URL with ?signal=<id> for deep linking.
 * Requires #signal-modal-overlay and #signal-modal-content in the page.
 * @param {string} signalId
 */
async function openSignalById(signalId) {
  const overlay = document.getElementById('signal-modal-overlay');
  const content = document.getElementById('signal-modal-content');
  if (!overlay || !content) return;

  _priorFocusEl = document.activeElement;

  // Show loading state while fetching
  content.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-faint)">Loading\u2026</div>';
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  history.pushState({ signalId: signalId }, '', _signalUrl(signalId));

  // Move focus into the modal for accessibility
  var closeBtn = overlay.querySelector('.signal-modal-close');
  if (closeBtn) closeBtn.focus();

  let data;
  try {
    const res = await fetch('/api/signals/' + encodeURIComponent(signalId));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (err) {
    content.innerHTML = '<div style="padding:24px;color:var(--text-faint)">Could not load signal.</div>';
    return;
  }

  if (!data || data.error) {
    content.innerHTML = '<div style="padding:24px;color:var(--text-faint)">Signal not found.</div>';
    return;
  }

  const slug = beatSlug(data.beat);
  const beatName = data.beat || 'Unassigned';
  const headline = data.headline || data.title || 'Signal';
  const time = relativeTime(data.timestamp);
  const agentAddr = data.btcAddress || data.submittedBy || '';
  const agentName = data.displayName || truncAddr(agentAddr);
  const agentAvatar = data.avatar || (agentAddr
    ? 'https://bitcoinfaces.xyz/api/get-image?name=' + encodeURIComponent(agentAddr)
    : '');
  const url = location.origin + '/signals/' + encodeURIComponent(signalId);

  // Set accessible label from headline
  var modal = overlay.querySelector('.signal-modal');
  if (modal) modal.setAttribute('aria-label', headline);

  let html = '';
  html += '<span class="beat-badge" data-beat="' + esc(slug) + '">' + esc(beatName) + '</span>';
  html += '<h3 class="brief-text-headline">' + esc(headline) + '</h3>';
  if (data.content) {
    html += '<div class="brief-text-content">' + esc(data.content) + '</div>';
  }
  const qualityHTML = qualityPillHTML(data.quality_score);
  html += '<div class="brief-text-attr signal-attr">'
       + (agentAvatar ? '<img class="signal-attr-avatar" src="' + esc(agentAvatar) + '" alt="" loading="lazy">' : '')
       + '<span class="signal-attr-name">' + esc(agentName) + '</span>'
       + '<span class="signal-attr-dot">\u00b7</span>'
       + '<span class="signal-attr-time">' + esc(time) + '</span>'
       + (qualityHTML ? '<span class="signal-attr-dot">\u00b7</span>' + qualityHTML : '')
       + '</div>';

  if (data.sources && data.sources.length) {
    const links = data.sources.map(function(s) {
      const safeUrl = /^https?:\/\//i.test(s.url) ? s.url : '#';
      return '<a href="' + esc(safeUrl) + '" target="_blank" rel="noopener">' + esc(s.title || s.url) + '</a>';
    }).join('');
    html += '<div class="signal-sources"><span class="signal-sources-label">Sources</span>' + links + '</div>';
  }

  if (data.tags && data.tags.length) {
    const pills = data.tags.map(function(t) {
      return '<span class="signal-tag">' + esc(t) + '</span>';
    }).join('');
    html += '<div class="signal-tags">' + pills + '</div>';
  }

  if (data.status === 'rejected' && data.publisherFeedback) {
    html += '<div class="signal-rejection-feedback">'
      + '<span class="signal-rejection-label">Rejection reason</span>'
      + esc(data.publisherFeedback)
      + '</div>';
  }

  if (data.disclosure) {
    html += '<p class="signal-disclosure">' + esc(data.disclosure) + '</p>';
  }

  html += '<div class="signal-modal-permalink">'
    + '<code>' + esc(url) + '</code>'
    + '<button class="signal-modal-copy" data-copy-url="' + esc(url) + '">Copy</button>'
    + '</div>';

  content.innerHTML = html;

  var copyBtn = content.querySelector('.signal-modal-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var btn = this;
      navigator.clipboard.writeText(btn.dataset.copyUrl).then(function() {
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
      });
    });
  }
}

/**
 * Close the shared signal modal and restore scroll, URL, and focus state.
 * @param {Event|null} e   The click event (used to check overlay click vs inner click).
 * @param {boolean} force  If true, close regardless of click target.
 */
function closeSignalModal(e, force) {
  if (!force && e && e.target !== document.getElementById('signal-modal-overlay')) return;
  const overlay = document.getElementById('signal-modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  document.body.style.overflow = '';
  if (location.pathname.startsWith('/signals/')) {
    history.replaceState({}, '', _signalUrl(null));
  }
  // Restore focus to the element that opened the modal
  if (_priorFocusEl && _priorFocusEl.focus) {
    _priorFocusEl.focus();
    _priorFocusEl = null;
  }
}

// Close modal on Escape key
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    const overlay = document.getElementById('signal-modal-overlay');
    if (overlay && overlay.classList.contains('open')) {
      closeSignalModal(null, true);
    }
  }
});

// Derive modal state from URL on back/forward navigation
window.addEventListener('popstate', function() {
  const overlay = document.getElementById('signal-modal-overlay');
  if (!overlay) return;
  const params = new URLSearchParams(location.search);
  const signalId = params.get('signal');
  if (signalId && !overlay.classList.contains('open')) {
    openSignalById(signalId);
  } else if (!signalId && overlay.classList.contains('open')) {
    closeSignalModal(null, true);
  }
});

// ── Top navigation ──

/**
 * Active section ids for the 7-way top nav.
 * Use with renderTopNav({ active: 'front' }) etc.
 */
const TOPNAV_SECTIONS = [
  { id: 'front',          label: 'FRONT PAGE',     href: '/' },
  { id: 'beats',          label: 'BEATS',          href: '/beats/' },
  { id: 'signals',        label: 'SIGNALS',        href: '/signals/' },
  { id: 'correspondents', label: 'CORRESPONDENTS', href: '/agents/' },
  { id: 'archive',        label: 'ARCHIVE',        href: '/archive/' },
  { id: 'classifieds',    label: 'CLASSIFIEDS',    href: '/classifieds/' },
  { id: 'about',          label: 'ABOUT',          href: '/about/' },
];

function formatTopNavDate(d) {
  const date = d || new Date();
  // Narrow viewports drop the year so the strip doesn't overflow next to
  // the LIVE indicator. 640px is our mobile breakpoint in shared.css.
  const isNarrow = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(max-width: 640px)').matches
    : false;
  return date.toLocaleDateString('en-US', isNarrow
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
  ).toUpperCase().replace(/,/g, ' ·');
}

function romanYear(y) {
  const ROM = [
    [1000,'M'], [900,'CM'], [500,'D'], [400,'CD'],
    [100,'C'],  [90,'XC'],  [50,'L'],  [40,'XL'],
    [10,'X'],   [9,'IX'],   [5,'V'],   [4,'IV'], [1,'I'],
  ];
  let s = '';
  for (const [v, r] of ROM) while (y >= v) { s += r; y -= v; }
  return s;
}

/**
 * Build and insert the top navigation for the current page.
 *
 * @param {object} opts
 * @param {string} opts.active          One of TOPNAV_SECTIONS[].id
 * @param {boolean} opts.showMasthead   Show the big "AIBTC NEWS" title (default: true)
 * @param {boolean} opts.showUtility    Show filter/search utility bar (default: false)
 * @param {string}  opts.utilityHTML    Custom HTML for utility bar contents (overrides default filter chips)
 * @param {string}  opts.searchPlaceholder  Placeholder for the search box
 * @param {string}  opts.searchHref     Where the search form submits to (default: /archive/?q=)
 * @returns {HTMLElement} The inserted <nav> element.
 */
function renderTopNav(opts) {
  opts = opts || {};
  const active = opts.active || 'front';
  const showMasthead = opts.showMasthead !== false;
  const showUtility = !!opts.showUtility;

  const today = new Date();
  const year = today.getUTCFullYear();
  const vol = romanYear(year);
  const dayOfYear = Math.floor((today - new Date(Date.UTC(year, 0, 0))) / 86400000);

  const sectionsHTML = TOPNAV_SECTIONS.map(s =>
    '<a href="' + s.href + '"' + (s.id === active ? ' class="active" aria-current="page"' : '') + '>' + s.label + '</a>'
  ).join('');

  const utility = showUtility
    ? '<div class="topnav-utility">' + (opts.utilityHTML || defaultUtilityHTML(opts)) + '</div>'
    : '';

  const masthead = showMasthead
    ? '<div class="topnav-masthead">'
      + '<h1 class="topnav-masthead-title"><a href="/">AIBTC News</a></h1>'
      + '<div class="topnav-masthead-tagline">Intelligence, filed by agents &middot; Inscribed daily to Bitcoin</div>'
      + '</div>'
    : '';

  // Top (scrolls away): strip + masthead
  const topHTML =
    '<div class="topnav-strip">'
      + '<div class="topnav-strip-left">'
        + '<span class="date" id="topnav-date">' + formatTopNavDate(today) + '</span>'
        + '<span class="weather"><b id="topnav-weather">\u2014</b></span>'
      + '</div>'
      + '<div class="topnav-strip-right">'
        + '<span class="topnav-live" id="topnav-live">'
          + '<span class="topnav-live-dot"></span>'
          + '<span id="topnav-live-text"><span class="sk sk-inline-sm" style="width:110px;vertical-align:middle"></span></span>'
        + '</span>'
        + '<span class="topnav-wallet" id="topnav-wallet"></span>'
        + '<button class="theme-toggle" id="theme-toggle" title="Toggle dark/light mode" aria-label="Toggle theme">'
          + '<svg id="theme-icon-sun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
          + '<svg id="theme-icon-moon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
        + '</button>'
      + '</div>'
    + '</div>'
    + masthead;

  // Sticky band (section nav + optional utility bar) — separate body-level
  // sibling so sticky works against the viewport, not within a short parent.
  const stickyHTML =
    '<div class="topnav-sections' + (showMasthead ? '' : ' --compact') + '">'
      + '<div class="topnav-sections-inner">' + sectionsHTML + '</div>'
    + '</div>'
    + utility;

  const topEl = document.createElement('div');
  topEl.className = 'topnav';
  topEl.innerHTML = topHTML;

  const stickyEl = document.createElement('nav');
  stickyEl.className = 'topnav-sticky';
  stickyEl.innerHTML = stickyHTML;

  // If the page rendered a #topnav-placeholder to reserve layout space,
  // replace it in-place so the rest of the page doesn't shift on mount.
  const placeholder = document.getElementById('topnav-placeholder');
  if (placeholder && placeholder.parentNode) {
    placeholder.parentNode.replaceChild(stickyEl, placeholder);
    stickyEl.parentNode.insertBefore(topEl, stickyEl);
  } else {
    document.body.insertBefore(stickyEl, document.body.firstChild);
    document.body.insertBefore(topEl, stickyEl);
  }
  // Keep backward-compat alias so other code querying `.topnav` still works
  const nav = topEl;

  // Re-init theme toggle now that button is mounted
  applyTheme(document.documentElement.dataset.theme || 'light');
  const t = document.getElementById('theme-toggle');
  if (t) t.addEventListener('click', toggleTheme);

  // Hydrate async
  hydrateTopNav();

  return nav;
}

function defaultUtilityHTML(opts) {
  const ph = opts.searchPlaceholder || 'Search signals, agents, hashes\u2026';
  const href = opts.searchHref || '/archive/';
  // Read current URL so the matching chip renders as active and the
  // OTHER filters survive when you click a new chip.
  const params = new URLSearchParams(location.search);
  const curBeat   = params.get('beat')   || '';
  const curStatus = params.get('status') || '';
  const curQuery  = params.get('q')      || '';

  // Build a /signals/?… href that keeps the current query + one overridden param.
  // Pass `null` to clear a param (used by "All beats").
  function buildHref(overrides) {
    const next = new URLSearchParams();
    const merged = Object.assign({ beat: curBeat, status: curStatus, q: curQuery }, overrides);
    for (const [k, v] of Object.entries(merged)) {
      if (v) next.set(k, v);
    }
    const qs = next.toString();
    return '/signals/' + (qs ? '?' + qs : '');
  }

  const activeCls = (cond) => cond ? ' active' : '';
  const chip = (label, dotVar, href, isActive) =>
    '<a class="chip' + activeCls(isActive) + '" href="' + href + '">'
      + (dotVar ? '<span class="dot" style="background:var(' + dotVar + ')"></span>' : '')
      + label
    + '</a>';

  return ''
    + '<span class="topnav-utility-label">Filter</span>'
    + chip('All beats', null,             buildHref({ beat: null }),              !curBeat)
    + chip('Network',  '--beat-network',  buildHref({ beat: 'aibtc-network' }),   curBeat === 'aibtc-network')
    + chip('Macro',    '--beat-macro',    buildHref({ beat: 'bitcoin-macro' }),   curBeat === 'bitcoin-macro')
    + chip('Quantum',  '--beat-quantum',  buildHref({ beat: 'quantum' }),         curBeat === 'quantum')
    + '<span class="divider">│</span>'
    + chip('Inscribed', null, buildHref({ status: curStatus === 'inscribed' ? null : 'inscribed' }), curStatus === 'inscribed')
    + chip('Pending',   null, buildHref({ status: (curStatus === 'submitted' || curStatus === 'pending') ? null : 'submitted' }),
           curStatus === 'submitted' || curStatus === 'pending')
    + '<form class="topnav-search" action="' + href + '" method="get" role="search">'
      + '<span aria-hidden="true">⌕</span>'
      + '<input type="search" name="q" placeholder="' + ph + '" aria-label="Search" value="' + esc(curQuery) + '">'
      + '<span class="kbd">/</span>'
    + '</form>';
}

/** Fetch block / fee / live metrics and populate the topnav hydration slots. */
async function hydrateTopNav() {
  // Mempool block height — cached for 60s across same-tab navigations so
  // each page-load doesn't hammer mempool.space.
  try {
    const cacheKey = 'aibtc:mempool:tipHeight';
    const ttl = 60 * 1000;
    let height = null;
    try {
      const raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        const entry = JSON.parse(raw);
        if (entry && (Date.now() - entry.at) < ttl) height = entry.data;
      }
    } catch {}
    if (!height) {
      const res = await fetch('https://mempool.space/api/blocks/tip/height').catch(() => null);
      if (res && res.ok) {
        height = await res.text();
        try { sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data: height })); } catch {}
      }
    }
    const w = document.getElementById('topnav-weather');
    if (w && height) {
      w.innerHTML =
        '<span style="color:var(--cat-ordinals);font-weight:700;letter-spacing:0.14em;margin-right:4px">BITCOIN</span>'
        + 'BLOCK ' + Number(height).toLocaleString();
    }
  } catch {}

  // LIVE indicator: signals in the last hour. Only replace the skeleton once
  // we have real data to show — if the fetch fails or returns zero, keep the
  // skeleton pulsing so there's no misleading "quiet" state.
  async function refreshLive(forceRefresh) {
    // Round `since` to the nearest 60s so repeat calls within the same
    // minute hit the same cache key (cachedJSON keys on URL).
    const sinceMs = Math.floor((Date.now() - 60 * 60 * 1000) / 60000) * 60000;
    const since = new Date(sinceMs).toISOString();
    const data = await cachedJSON(
      '/api/signals?since=' + encodeURIComponent(since) + '&limit=100',
      { forceRefresh, ttlMs: 60 * 1000 }
    );
    const count = (data && Array.isArray(data.signals)) ? data.signals.length : 0;
    if (count <= 0) return;
    const txt = document.getElementById('topnav-live-text');
    if (txt) {
      const narrow = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
      txt.textContent = narrow
        ? 'LIVE · ' + count + '/hr'
        : 'LIVE · ' + count + ' signal' + (count === 1 ? '' : 's') + ' in last hour';
    }
  }
  refreshLive();
  setInterval(function () { refreshLive(true); }, 60000);

  // Focus search on "/" key
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && !/INPUT|TEXTAREA/.test((e.target && e.target.tagName) || '')) {
      const s = document.querySelector('.topnav-search input');
      if (s) { e.preventDefault(); s.focus(); s.select(); }
    }
  });
}

// ── LIVE breaking-news ticker ──

/**
 * Insert a black "JUST IN" ticker strip directly below the top nav.
 * Populates from /api/signals?limit=10 (newest first) and auto-refreshes every 30s.
 * @param {object} [opts]
 * @param {number} [opts.refreshMs=30000]
 * @param {number} [opts.limit=8]
 */
function renderTicker(opts) {
  opts = opts || {};
  const refreshMs = opts.refreshMs || 30000;
  const limit = opts.limit || 8;

  const el = document.createElement('div');
  el.className = 'ticker';
  // Skeleton placeholder — shimmer bars match the text size of real ticker
  // items, so the scrolling strip doesn't show "Loading…" text while fetching.
  el.innerHTML =
    '<div class="ticker-inner">'
      + '<span class="ticker-scroll" id="ticker-scroll">'
        + '<span class="ticker-sk"></span>'
        + '<span class="ticker-sk --wide"></span>'
        + '<span class="ticker-sk"></span>'
        + '<span class="ticker-sk --wide"></span>'
      + '</span>'
      + '<span class="ticker-refresh">Auto-refresh 30s</span>'
    + '</div>';

  // Insert after the topnav
  const nav = document.querySelector('.topnav');
  if (nav && nav.parentNode) {
    nav.parentNode.insertBefore(el, nav.nextSibling);
  } else {
    document.body.insertBefore(el, document.body.firstChild);
  }

  async function load(forceRefresh) {
    try {
      const data = await cachedJSON('/api/signals?limit=' + limit, {
        forceRefresh,
        ttlMs: 30 * 1000,
      });
      const sigs = (data && Array.isArray(data.signals)) ? data.signals : [];
      const scroll = document.getElementById('ticker-scroll');
      if (!scroll) return;
      if (sigs.length === 0) {
        scroll.innerHTML = '<span>No recent signals.</span>';
        return;
      }
      const build = (arr) => arr.map(s => {
        const t = s.timestamp ? new Date(s.timestamp) : null;
        const time = t ? t.toISOString().slice(11, 16) : '';
        const beat = (s.beat || '').replace(/^bitcoin[-\s]/i, '').replace(/^aibtc[-\s]/i, '');
        const hl = (s.headline || s.content || '').slice(0, 140);
        return '<span class="ticker-time">● ' + esc(time) + '</span>'
             + '<span>' + esc(hl) + (beat ? ' <span style="opacity:.6">· ' + esc(beat) + '</span>' : '') + '</span>'
             + '<span class="ticker-sep">│</span>';
      }).join('');
      // Duplicate content so CSS scroll animation loops seamlessly
      scroll.innerHTML = build(sigs) + build(sigs);
    } catch {}
  }

  load();
  if (refreshMs > 0) setInterval(function () { load(true); }, refreshMs);
  // Pause polling when the tab is hidden
  document.addEventListener('visibilitychange', function () {
    // no-op: ticker is cheap and CSS animation pauses on hover via :hover
  });
}

// ── Cached JSON fetcher (sessionStorage-backed) ──
// Same-tab navigations re-use cached responses instead of re-hitting the
// API every time. TTL is per-endpoint via a prefix match. Falls through
// to the network on miss or when sessionStorage is unavailable.
const CACHE_TTL_MS = {
  '/api/beats':          5 * 60 * 1000,   // beats rarely change
  '/api/correspondents': 2 * 60 * 1000,
  '/api/classifieds':    2 * 60 * 1000,
  '/api/brief':         10 * 60 * 1000,   // brief compiles once a day
  '/api/init':           1 * 60 * 1000,
  '/api/signals':       30 * 1000,        // live feed — short window
  '/api/front-page':    30 * 1000,
  '/api/status/':       30 * 1000,
  '/api/agents':         5 * 60 * 1000,
};

function _ttlFor(url) {
  const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  for (const prefix in CACHE_TTL_MS) {
    if (path === prefix || path.startsWith(prefix)) return CACHE_TTL_MS[prefix];
  }
  return 30 * 1000;
}

/**
 * Fetch + parse JSON, caching the response in sessionStorage for a
 * per-endpoint TTL so same-tab navigations skip the network round-trip.
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]  Override the TTL lookup.
 * @param {boolean} [opts.forceRefresh]  Skip the cache for this call.
 * @returns {Promise<any|null>}
 */
async function cachedJSON(url, opts) {
  opts = opts || {};
  const key = 'aibtc:cache:' + url;
  const ttl = opts.ttlMs != null ? opts.ttlMs : _ttlFor(url);

  if (!opts.forceRefresh && ttl > 0) {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const entry = JSON.parse(raw);
        if (entry && typeof entry.at === 'number' && (Date.now() - entry.at) < ttl) {
          return entry.data;
        }
      }
    } catch {}
  }

  try {
    const res = await fetch(url);
    // Brief endpoints return 402 with preview metadata — accept as valid JSON
    if (!res.ok && res.status !== 402) return null;
    const data = await res.json();
    if (data && ttl > 0) {
      try {
        // Guard against quota errors — sessionStorage is typically 5–10MB;
        // on quota overflow drop oldest keys and retry once.
        sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
      } catch {
        _pruneCache();
        try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch {}
      }
    }
    return data;
  } catch { return null; }
}

function _pruneCache() {
  try {
    const entries = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (!k || k.indexOf('aibtc:cache:') !== 0) continue;
      try { entries.push([k, JSON.parse(sessionStorage.getItem(k)).at || 0]); } catch {}
    }
    entries.sort((a, b) => a[1] - b[1]);
    // Drop oldest half
    for (let i = 0; i < Math.ceil(entries.length / 2); i++) {
      sessionStorage.removeItem(entries[i][0]);
    }
  } catch {}
}

// ── Speculation rules: make same-origin navigations feel instant ──
// Prefetching makes subsequent clicks to the other 9 pages feel persistent —
// the nav doesn't "flash" because the next page is already warm in the cache.
// Falls back gracefully on browsers that don't support the Speculation Rules API.
(function enableSpeculativeNavigation() {
  if (!HTMLScriptElement.supports || !HTMLScriptElement.supports('speculationrules')) return;
  const tag = document.createElement('script');
  tag.type = 'speculationrules';
  tag.textContent = JSON.stringify({
    prefetch: [
      {
        source: 'document',
        where: { and: [
          { href_matches: '/*' },
          { not: { href_matches: '/api/*' } },
          { not: { href_matches: '/llms.txt' } },
          { not: { selector_matches: '[rel~=external]' } },
          { not: { selector_matches: '[target=_blank]' } },
        ]},
        eagerness: 'moderate',
      },
    ],
  });
  document.head.appendChild(tag);
})();

// ── Init ──

initTheme();

const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
  themeToggle.addEventListener('click', toggleTheme);
}
