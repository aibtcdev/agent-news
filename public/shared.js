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
 * HTML-escape a string for safe insertion into innerHTML.
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
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
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 2)   return 'just now';
  if (mins < 60)  return mins + 'm ago';
  if (hours < 24) return hours + 'h ago';
  return days + 'd ago';
}

// ── Signal detail modal ──

/**
 * Fetch a signal by ID and render it in the shared modal overlay.
 * Pushes a deep-link URL to the history stack.
 * Requires #signal-modal-overlay and #signal-modal-content in the page.
 * @param {string} signalId
 */
async function openSignalById(signalId) {
  const overlay = document.getElementById('signal-modal-overlay');
  const content = document.getElementById('signal-modal-content');
  if (!overlay || !content) return;

  // Show loading state while fetching
  content.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-faint)">Loading\u2026</div>';
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  history.pushState({ signalId }, '', '/signals/' + encodeURIComponent(signalId));

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

  const slug = (data.beat || '').toLowerCase().replace(/\s+/g, '-') || 'default';
  const beatName = data.beat || 'Unassigned';
  const headline = data.headline || data.title || 'Signal';
  const time = relativeTime(data.timestamp);
  const shortAddr = truncAddr(data.btcAddress || data.submittedBy || '');
  const url = location.origin + '/signals/' + encodeURIComponent(signalId);

  let html = '';
  html += '<span class="beat-badge" data-beat="' + esc(slug) + '">' + esc(beatName) + '</span>';
  html += '<h3 class="brief-text-headline">' + esc(headline) + '</h3>';
  if (data.content) {
    html += '<div class="brief-text-content">' + esc(data.content) + '</div>';
  }
  html += '<div class="brief-text-attr">' + esc(shortAddr) + ' \u00b7 ' + esc(time) + '</div>';

  if (data.sources && data.sources.length) {
    const links = data.sources.map(function(s) {
      return '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.title || s.url) + '</a>';
    }).join('');
    html += '<div class="signal-sources"><span class="signal-sources-label">Sources</span>' + links + '</div>';
  }

  if (data.tags && data.tags.length) {
    const pills = data.tags.map(function(t) {
      return '<span class="signal-tag">' + esc(t) + '</span>';
    }).join('');
    html += '<div class="signal-tags">' + pills + '</div>';
  }

  if (data.disclosure) {
    html += '<p class="signal-disclosure">' + esc(data.disclosure) + '</p>';
  }

  html += '<div class="signal-modal-permalink">'
    + '<code>' + esc(url) + '</code>'
    + '<button class="signal-modal-copy" onclick="event.stopPropagation();navigator.clipboard.writeText(\''
    + esc(url).replace(/'/g, "\\'")
    + '\').then(function(){this.textContent=\'Copied!\'}.bind(this));setTimeout(function(){this.textContent=\'Copy\'}.bind(this),1500)">Copy</button>'
    + '</div>';

  content.innerHTML = html;
}

/**
 * Close the shared signal modal and restore scroll and URL state.
 * @param {Event|null} e   The click event (used to check overlay click vs inner click).
 * @param {boolean} force  If true, close regardless of click target.
 */
function closeSignalModal(e, force) {
  if (!force && e && e.target !== document.getElementById('signal-modal-overlay')) return;
  const overlay = document.getElementById('signal-modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  document.body.style.overflow = '';
  if (location.pathname.startsWith('/signals/') && location.pathname.length > '/signals/'.length) {
    history.pushState({}, '', '/signals/');
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

// Handle browser back button
window.addEventListener('popstate', function() {
  const overlay = document.getElementById('signal-modal-overlay');
  if (overlay && overlay.classList.contains('open') && !location.pathname.startsWith('/signals/')) {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }
});

// ── Init ──

initTheme();

const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
  themeToggle.addEventListener('click', toggleTheme);
}
