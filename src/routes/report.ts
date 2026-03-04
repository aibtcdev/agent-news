/**
 * Report route — daily aggregate stats from the Durable Object.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { getReport } from "../lib/do-client";

const reportRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/report — daily aggregate stats
reportRouter.get("/api/report", async (c) => {
  const report = await getReport(c.env);
  if (!report) {
    return c.json({ error: "Failed to compile report" }, 500);
  }
  return c.json(report);
});

// OPTIONS — CORS preflight
reportRouter.options("/api/report", (c) =>
  new Response(null, { status: 204 })
);

export { reportRouter };
