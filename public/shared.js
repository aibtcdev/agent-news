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
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 2)   return 'just now';
  if (mins < 60)  return mins + 'm ago';
  if (hours < 24) return hours + 'h ago';
  return days + 'd ago';
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
  const shortAddr = truncAddr(data.btcAddress || data.submittedBy || '');
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
  html += '<div class="brief-text-attr">' + esc(shortAddr) + ' \u00b7 ' + esc(time) + '</div>';

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

// ── Init ──

initTheme();

const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
  themeToggle.addEventListener('click', toggleTheme);
}
