/**
 * Streaks route — streak leaderboard.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { listStreaks } from "../lib/do-client";

const streaksRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/streaks — streak leaderboard with optional ?limit param
streaksRouter.get("/api/streaks", async (c) => {
  const limitParam = c.req.query("limit");
  const limit = limitParam
    ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 200)
    : undefined;

  const streaks = await listStreaks(c.env, limit);
  return c.json({ streaks, total: streaks.length });
});

// OPTIONS — CORS preflight
streaksRouter.options("/api/streaks", (c) =>
  new Response(null, { status: 204 })
);

export { streaksRouter };
