import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getSignalCounts } from "../lib/do-client";

const signalCountsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/signals/counts - lightweight signal counts by status
// Returns counts grouped by status without fetching full signal records.
// Supports optional filters: beat, agent, since.
signalCountsRouter.get("/api/signals/counts", async (c) => {
  const beat = c.req.query("beat");
  const agent = c.req.query("agent");
  const since = c.req.query("since");

  try {
    const counts = await getSignalCounts(c.env, { beat, agent, since });
    c.header("Cache-Control", "public, max-age=30, s-maxage=60");
    return c.json(counts);
  } catch (err) {
    return c.json({ ok: false, error: "Failed to fetch signal counts" }, 500);
  }
});

export { signalCountsRouter };
