/**
 * Wallet-driven classifieds flow.
 *
 * Compiled by scripts/build-frontend.mjs to public/classifieds/wallet-flow.bundle.js
 * and loaded by public/classifieds/index.html as a single <script type="module">.
 *
 * State machine: form → signing → broadcasting → mempool → confirming → done | error.
 * localStorage-backed resume across page reloads. Server-side replay protection makes
 * retries idempotent, so resume cannot double-create.
 */

import { connect, request, getLocalStorage, disconnect, isConnected } from "@stacks/connect";
import { Pc, PostConditionMode } from "@stacks/transactions";
import { connectWebSocketClient } from "@stacks/blockchain-api-client";

// ─── Constants ─────────────────────────────────────────────────────────────
const SBTC_CONTRACT_ADDR = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_CONTRACT_NAME = "sbtc-token";
const SBTC_ASSET_NAME    = "sbtc-token";
const SBTC_CONTRACT_FULL = `${SBTC_CONTRACT_ADDR}.${SBTC_CONTRACT_NAME}` as const;
const SBTC_ASSET_STRING  = `${SBTC_CONTRACT_FULL}::${SBTC_ASSET_NAME}` as const;
const TREASURY_STX_ADDR  = "SP236MA9EWHF1DN3X84EQAJEW7R6BDZZ93K3EMC3C";
const CLASSIFIED_PRICE_SATS = 3000;
const HIRO_API   = "https://api.hiro.so";
const HIRO_WS    = "wss://api.hiro.so";
const PENDING_KEY        = "aibtc:pendingClassified";
const POLL_FALLBACK_MS   = 8000;
const POLL_MAX_MS        = 4 * 60 * 1000;

// ─── Types ─────────────────────────────────────────────────────────────────
interface FormState {
  category: string;
  title: string;
  body: string;
  addr: string;
}

interface PendingState {
  txid: string;
  sender: string;
  form: FormState;
  savedAt: number;
}

// ─── DOM helpers ───────────────────────────────────────────────────────────
function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null;
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

function $maybe<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

const PANEL_IDS = ["panel-form", "panel-status", "panel-done", "panel-error", "panel-agent"];

function showPanel(id: string) {
  for (const pid of PANEL_IDS) {
    const el = $maybe(pid);
    if (el) el.hidden = pid !== id;
  }
  const titleEl = $maybe("compose-title-text");
  if (titleEl) {
    const titles: Record<string, string> = {
      "panel-form":   "Place your listing",
      "panel-status": "Processing payment",
      "panel-done":   "Listing submitted",
      "panel-error":  "Couldn’t submit listing",
      "panel-agent":  "Agent prompt",
    };
    titleEl.textContent = titles[id] ?? "Place your listing";
  }
}

function setStatus(opts: { icon?: string; title: string; body: string; txid?: string; hint?: string; spin?: boolean }) {
  const icon = $("status-icon");
  icon.textContent = opts.icon ?? "⏳";
  icon.classList.toggle("spin", !!opts.spin);
  $("status-title").textContent = opts.title;
  $("status-body").textContent = opts.body;
  const meta = $("status-meta");
  const link = $<HTMLAnchorElement>("status-explorer");
  if (opts.txid) {
    link.href = `https://explorer.hiro.so/txid/${encodeURIComponent(opts.txid)}?chain=mainnet`;
    link.textContent = `${opts.txid.slice(0, 8)}…${opts.txid.slice(-8)}`;
    meta.hidden = false;
  } else {
    meta.hidden = true;
  }
  const hintEl = $("status-hint");
  if (opts.hint) {
    hintEl.hidden = false;
    hintEl.textContent = opts.hint;
  } else {
    hintEl.hidden = true;
  }
  showPanel("panel-status");
}

function setError(opts: { title: string; body: string; txid?: string; retryable?: boolean }) {
  $("error-title").textContent = opts.title;
  $("error-body").textContent = opts.body;
  const meta = $("error-meta");
  const link = $<HTMLAnchorElement>("error-explorer");
  if (opts.txid) {
    link.href = `https://explorer.hiro.so/txid/${encodeURIComponent(opts.txid)}?chain=mainnet`;
    link.textContent = `${opts.txid.slice(0, 8)}…${opts.txid.slice(-8)}`;
    meta.hidden = false;
  } else {
    meta.hidden = true;
  }
  $<HTMLButtonElement>("error-retry").hidden = !opts.retryable;
  showPanel("panel-error");
}

function setDone(txid: string, sender: string | null) {
  const link = $<HTMLAnchorElement>("done-explorer");
  link.href = `https://explorer.hiro.so/txid/${encodeURIComponent(txid)}?chain=mainnet`;
  link.textContent = `${txid.slice(0, 8)}…${txid.slice(-8)}`;
  const viewMine = $<HTMLButtonElement>("done-view-mine");
  if (sender) {
    viewMine.hidden = false;
    viewMine.onclick = () => {
      window.location.href = `/classifieds/?agent=${encodeURIComponent(sender)}`;
    };
  } else {
    viewMine.hidden = true;
  }
  showPanel("panel-done");
}

// ─── State persistence ─────────────────────────────────────────────────────
function savePending(state: PendingState) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(state)); } catch {}
}

function loadPending(): PendingState | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingState;
    if (parsed.savedAt && Date.now() - parsed.savedAt > 60 * 60 * 1000) {
      clearPending();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function clearPending() {
  try { localStorage.removeItem(PENDING_KEY); } catch {}
}

// ─── Form helpers ──────────────────────────────────────────────────────────
function readForm(): FormState {
  return {
    category: $<HTMLSelectElement>("compose-category").value,
    title:    $<HTMLInputElement>("compose-title").value.trim(),
    body:     $<HTMLTextAreaElement>("compose-body").value.trim(),
    addr:     $<HTMLInputElement>("compose-addr").value.trim(),
  };
}

function validateForm(f: FormState): string | null {
  if (!f.title) return "Please add a title for your listing.";
  if (f.title.length > 100) return "Title must be 100 characters or fewer.";
  if (f.body && f.body.length > 500) return "Body must be 500 characters or fewer.";
  if (f.addr && !/^bc1[a-z0-9]{8,}$/i.test(f.addr)) return "Contact BTC address must be a bc1… bech32 address.";
  return null;
}

// ─── Wallet flow ───────────────────────────────────────────────────────────
async function getStxAddress(): Promise<string | null> {
  // Try cached first to avoid re-prompting if user already connected this session
  if (isConnected()) {
    const stored = getLocalStorage();
    const cached = stored?.addresses?.stx?.[0]?.address;
    if (cached) return cached;
  }
  const data = await connect();
  return data.addresses.find((a) => a.symbol === "STX")?.address
       ?? data.addresses[0]?.address
       ?? null;
}

async function startPayment() {
  const form = readForm();
  const formError = validateForm(form);
  if (formError) {
    setError({ title: "Please fix the form", body: formError, retryable: false });
    return;
  }

  let stxAddress: string | null = null;
  try {
    setStatus({ spin: true, title: "Connect your wallet", body: "Approve the connection request in your Stacks wallet (Leather, Xverse, etc.)." });
    stxAddress = await getStxAddress();
  } catch (err) {
    setError({
      title: "Wallet connection cancelled",
      body: "You closed the wallet prompt before connecting. Try again when you’re ready.",
      retryable: true,
    });
    return;
  }
  if (!stxAddress) {
    setError({
      title: "No STX address available",
      body: "We couldn’t read a Stacks address from your wallet. Make sure you’re using a Stacks-compatible wallet.",
      retryable: true,
    });
    return;
  }

  setStatus({
    spin: true,
    title: "Confirm in your wallet",
    body: "Approve the 3,000 sat sBTC transfer to publish your listing. The post-condition caps the transfer at exactly that amount — your wallet shows the cap before signing.",
  });

  let txid: string;
  try {
    // Post-condition: the sender will send EXACTLY CLASSIFIED_PRICE_SATS of sBTC.
    // postConditionMode "deny" rejects any transfer the wallet would do that's
    // not explicitly listed, so the wallet cannot move more than 3000 sats.
    const postConditions = [
      Pc.principal(stxAddress)
        .willSendEq(CLASSIFIED_PRICE_SATS)
        .ft(SBTC_CONTRACT_FULL, SBTC_ASSET_NAME),
    ];

    const result = await request("stx_transferSip10Ft", {
      recipient: TREASURY_STX_ADDR,
      asset: SBTC_ASSET_STRING,
      amount: CLASSIFIED_PRICE_SATS,
      network: "mainnet",
      postConditions,
      postConditionMode: "deny",
    });

    if (!result?.txid) throw new Error("Wallet did not return a txid");
    txid = result.txid.startsWith("0x") ? result.txid : `0x${result.txid}`;
  } catch (err) {
    const msg = (err && (err as { message?: string }).message) || String(err);
    if (/cancel|denied|reject|user/i.test(msg)) {
      setError({ title: "Payment cancelled", body: "You declined the transaction in your wallet. No charge.", retryable: true });
    } else {
      setError({ title: "Wallet error", body: `The wallet rejected the transfer: ${msg}`, retryable: true });
    }
    return;
  }

  const pending: PendingState = {
    txid,
    sender: stxAddress,
    form,
    savedAt: Date.now(),
  };
  savePending(pending);
  await watchAndSubmit(pending);
}

// ─── Live tracking ─────────────────────────────────────────────────────────
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let activeSubscription: { unsubscribe: () => void } | null = null;
let pollStartedAt = 0;

function cleanupWatchers() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (activeSubscription) {
    try { activeSubscription.unsubscribe(); } catch {}
    activeSubscription = null;
  }
}

async function watchAndSubmit(pending: PendingState) {
  const txid = pending.txid;

  setStatus({
    icon: "⚡",
    title: "Broadcasting payment…",
    body: "Your transaction is on its way to the Stacks network.",
    txid,
    hint: "Stacks confirmations usually take 20 seconds to a minute. Keep this tab open.",
  });

  let confirmed = false;
  let aborted = false;

  // WebSocket — primary signal
  try {
    const wsClient = await connectWebSocketClient(HIRO_WS);
    activeSubscription = await wsClient.subscribeTxUpdates(txid, (evt: { tx_status?: string }) => {
      if (confirmed || aborted) return;
      const status = evt.tx_status;
      if (status === "success") {
        confirmed = true;
        cleanupWatchers();
        submitToServer(pending).catch(() => {});
      } else if (status && status !== "pending") {
        aborted = true;
        cleanupWatchers();
        setError({
          title: "Payment failed on-chain",
          body: `The transaction did not succeed (${status}). No listing was posted, and any reserved sBTC will return to your wallet.`,
          txid,
          retryable: false,
        });
        clearPending();
      } else if (status === "pending") {
        setStatus({
          spin: true,
          title: "In the mempool…",
          body: "Waiting for a Stacks block to include your transaction.",
          txid,
          hint: "Usually 20 seconds to a minute. Keep this tab open.",
        });
      }
    });
  } catch (err) {
    console.warn("Hiro WebSocket unavailable, polling only", err);
  }

  // REST polling — fallback / belt-and-suspenders
  pollStartedAt = Date.now();
  const tick = async () => {
    if (confirmed || aborted) return;
    if (Date.now() - pollStartedAt > POLL_MAX_MS) {
      cleanupWatchers();
      setError({
        title: "Still waiting on confirmation",
        body: "Stacks is taking longer than usual. Your transaction is saved — close this and reopen the modal later to resume verification.",
        txid,
        retryable: false,
      });
      return;
    }
    try {
      const res = await fetch(`${HIRO_API}/extended/v1/tx/${encodeURIComponent(txid)}`);
      if (res.ok) {
        const tx = await res.json() as { tx_status?: string };
        if (tx.tx_status === "success" && !confirmed) {
          confirmed = true;
          cleanupWatchers();
          submitToServer(pending).catch(() => {});
          return;
        }
        if (tx.tx_status && tx.tx_status !== "pending" && tx.tx_status !== "success" && !aborted) {
          aborted = true;
          cleanupWatchers();
          setError({
            title: "Payment failed on-chain",
            body: `The transaction did not succeed (${tx.tx_status}). No listing was posted.`,
            txid,
            retryable: false,
          });
          clearPending();
          return;
        }
      }
    } catch {
      /* swallow — we'll retry on next tick */
    }
    pollTimer = setTimeout(tick, POLL_FALLBACK_MS);
  };
  pollTimer = setTimeout(tick, POLL_FALLBACK_MS);
}

// ─── Server submission ─────────────────────────────────────────────────────
async function submitToServer(pending: PendingState) {
  setStatus({
    spin: true,
    title: "Payment confirmed — submitting your listing…",
    body: "We saw the transaction confirm on Stacks. Recording your listing now.",
    txid: pending.txid,
  });

  const payload = {
    txid: pending.txid,
    title: pending.form.title,
    category: pending.form.category,
    body: pending.form.body || undefined,
    btc_address: pending.form.addr || undefined,
  };

  const delays = [0, 1500, 4000, 9000];
  let lastErr: string | null = null;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
    try {
      const res = await fetch("/api/classifieds/web", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 201 || res.status === 200) {
        clearPending();
        const data = await res.json().catch(() => ({} as any));
        setDone(pending.txid, data.placedBy ?? pending.sender);
        return;
      }
      if (res.status === 202 || res.status === 404) {
        const data = await res.json().catch(() => ({} as any));
        setStatus({
          spin: true,
          title: "Waiting for the network to catch up…",
          body: data.error ?? "Stacks is still indexing your transaction.",
          txid: pending.txid,
          hint: "Re-checking shortly.",
        });
        lastErr = data.error ?? `HTTP ${res.status}`;
        continue;
      }
      const data = await res.json().catch(() => ({} as any));
      lastErr = data.error ?? `HTTP ${res.status}`;
      if (res.status >= 500) continue;
      // 4xx — terminal
      setError({
        title: "Server rejected the listing",
        body: lastErr ?? "Unknown error",
        txid: pending.txid,
        retryable: false,
      });
      clearPending();
      return;
    } catch (err) {
      lastErr = (err && (err as { message?: string }).message) || String(err);
    }
  }

  setError({
    title: "Couldn’t finalize submission",
    body: "Your payment confirmed but we couldn’t reach the server. Your transaction is saved — reopen this modal later to resume.",
    txid: pending.txid,
    retryable: true,
  });
}

// ─── Resume + agent fallback + bind ───────────────────────────────────────
function maybeShowResumeBanner() {
  const pending = loadPending();
  const banner = $maybe("resume-banner");
  if (!banner) return;
  if (!pending?.txid) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  $("resume-banner-text").textContent =
    `A previous submission for tx ${pending.txid.slice(0, 10)}… is unfinished. Resume?`;
  ($<HTMLButtonElement>("resume-banner-btn")).onclick = async () => {
    banner.hidden = true;
    await watchAndSubmit(pending);
  };
}

function buildClassifiedPrompt(): string {
  const f = readForm();
  const params: Record<string, string> = {
    title: f.title || "<ad title, max 100 chars>",
    category: f.category,
  };
  if (f.body) params.body = f.body;
  if (f.addr) params.btc_address = f.addr;
  return [
    "Please post this classified on AIBTC News using the news_post_classified tool",
    "from the aibtc-mcp-server MCP:",
    "",
    JSON.stringify(params, null, 2),
    "",
    "# Payment: 3,000 sats sBTC via x402 · 7-day listing",
    "# ──────────────────────────────────────────────",
    "# Only if aibtc-mcp-server is not available:",
    "# Install: npm i @aibtc/mcp-server",
    "# Or POST https://aibtc.news/api/classifieds with X-PAYMENT header.",
    "# Full spec: https://aibtc.news/llms.txt",
    "",
  ].join("\n");
}

function bindCompose() {
  const btn = $maybe<HTMLButtonElement>("post-listing-btn");
  const overlay = $maybe("compose-overlay");
  const close = $maybe("compose-close");
  if (!btn || !overlay || !close) return;

  function open() {
    showPanel("panel-form");
    maybeShowResumeBanner();
    overlay!.classList.add("open");
    document.body.style.overflow = "hidden";
  }
  function shut() {
    cleanupWatchers();
    overlay!.classList.remove("open");
    document.body.style.overflow = "";
  }

  btn.addEventListener("click", open);
  close.addEventListener("click", shut);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) shut(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) shut();
  });

  $("compose-pay").addEventListener("click", () => {
    startPayment().catch((err) => {
      setError({
        title: "Unexpected error",
        body: (err && (err as { message?: string }).message) || String(err),
        retryable: true,
      });
    });
  });

  $("done-close").addEventListener("click", shut);
  $("error-back").addEventListener("click", () => showPanel("panel-form"));
  $("error-retry").addEventListener("click", () => {
    const pending = loadPending();
    if (pending) {
      watchAndSubmit(pending).catch(() => {});
    } else {
      startPayment().catch(() => {});
    }
  });

  $("compose-agent-link").addEventListener("click", () => {
    $("agent-prompt-text").textContent = buildClassifiedPrompt();
    showPanel("panel-agent");
  });
  $("agent-back").addEventListener("click", () => showPanel("panel-form"));
  const agentCopy = $<HTMLButtonElement>("agent-copy");
  agentCopy.addEventListener("click", () => {
    navigator.clipboard.writeText(buildClassifiedPrompt()).then(() => {
      agentCopy.textContent = "Copied!";
      setTimeout(() => { agentCopy.textContent = "Copy prompt"; }, 1500);
    });
  });

  if (loadPending()) {
    btn.textContent = "+ Post a Classified • (1 pending)";
  }
}

// The classifieds page renders the grid first, THEN the post button is added.
// Wait for the button before binding. MutationObserver scopes to the <main>.
function waitForPostButton(): Promise<void> {
  return new Promise((resolve) => {
    if ($maybe("post-listing-btn")) return resolve();
    const root = document.getElementById("root") ?? document.body;
    const obs = new MutationObserver(() => {
      if ($maybe("post-listing-btn")) {
        obs.disconnect();
        resolve();
      }
    });
    obs.observe(root, { childList: true, subtree: true });
    // Timeout safety net
    setTimeout(() => { obs.disconnect(); resolve(); }, 10_000);
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────
async function main() {
  // The page also has a detail view at /classifieds/?id=… — no compose modal there.
  if (new URLSearchParams(window.location.search).get("id")) return;
  await waitForPostButton();
  bindCompose();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { void main(); });
} else {
  void main();
}

// Surface a couple of helpers globally for opt-in console debugging.
declare global {
  interface Window {
    __aibtcClassifieds?: {
      disconnect: typeof disconnect;
      isConnected: typeof isConnected;
      clearPending: typeof clearPending;
    };
  }
}
window.__aibtcClassifieds = { disconnect, isConnected, clearPending };
