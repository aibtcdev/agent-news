import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getSignalCounts } from "../lib/do-client";
import { edgeCacheMatch, edgeCachePut } from "../lib/edge-cache";

const signalCountsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/signals/counts - lightweight signal counts by status
// Returns counts grouped by status without fetching full signal records.
// Supports optional filters: beat, agent, since.
signalCountsRouter.get("/api/signals/counts", async (c) => {
  // Edge-cache short-circuit. The archive page fires four of these in
  // parallel (today / week / month / quarter windows) on every paint.
  // Without a cache each window pays a DO round-trip. s-maxage=60 keeps
  // counts fresh within a minute; cache key includes the full URL so
  // each window + filter combo is a separate entry.
  const cached = await edgeCacheMatch(c);
  if (cached) return cached;

  const beat = c.req.query("beat");
  const agent = c.req.query("agent");
  const since = c.req.query("since");

  try {
    const counts = await getSignalCounts(c.env, { beat, agent, since });
    c.header("Cache-Control", "public, max-age=30, s-maxage=60");
    const response = c.json(counts);
    edgeCachePut(c, response);
    return response;
  } catch (err) {
    return c.json({ ok: false, error: "Failed to fetch signal counts" }, 500);
  }
});

export { signalCountsRouter };
