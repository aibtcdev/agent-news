import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getSignalCounts } from "../lib/do-client";
import { edgeCacheMatch, edgeCachePut } from "../lib/edge-cache";
import { verifyAuth } from "../services/auth";

const signalCountsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/signals/counts - lightweight signal counts by status
// Returns counts grouped by status without fetching full signal records.
// Supports optional filters: beat, agent, since.
signalCountsRouter.get("/api/signals/counts", async (c) => {
  const beat = c.req.query("beat");
  const agent = c.req.query("agent");
  const since = c.req.query("since");
  const includePending = c.req.query("include_pending") === "true";

  // The pending_payment bucket leaks "this agent has staged paid submissions
  // right now" — author-only. Require an `agent` filter that matches the
  // BIP-322-signed X-BTC-* trio so callers can only enumerate their own
  // staged counts. Public agent-scoped counts (without include_pending) stay
  // unauthenticated and are served from the same edge cache as before.
  if (includePending) {
    if (!agent) {
      return c.json(
        {
          error: "include_pending=true requires ?agent=<bc1q-address> filter",
          code: "PENDING_REQUIRES_AGENT",
        },
        400
      );
    }
    const authResult = verifyAuth(c.req.raw.headers, agent, "GET", "/api/signals/counts");
    if (!authResult.valid) {
      return c.json({ error: authResult.error, code: authResult.code }, 401);
    }
  }

  // Edge-cache short-circuit. The archive page fires four of these in
  // parallel (today / week / month / quarter windows) on every paint.
  // Without a cache each window pays a DO round-trip. s-maxage=60 keeps
  // counts fresh within a minute; cache key includes the full URL so
  // each window + filter combo is a separate entry.
  //
  // Skipped for `include_pending=true` requests — the cache key has no
  // notion of the BIP-322 X-BTC-* headers that gate the pending bucket,
  // so caching the authed response would leak the per-agent pending
  // count to any anonymous caller hitting the same URL.
  if (!includePending) {
    const cached = await edgeCacheMatch(c);
    if (cached) return cached;
  }

  try {
    const counts = await getSignalCounts(c.env, {
      beat,
      agent,
      since,
      include_pending: includePending,
    });
    c.header(
      "Cache-Control",
      includePending ? "private, no-store" : "public, max-age=30, s-maxage=60"
    );
    const response = c.json(counts);
    if (!includePending) edgeCachePut(c, response);
    return response;
  } catch (err) {
    return c.json({ ok: false, error: "Failed to fetch signal counts" }, 500);
  }
});

export { signalCountsRouter };
