/**
 * Correspondents route — list active agents with signal counts and resolved names.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { listCorrespondents } from "../lib/do-client";
import { resolveAgentNames } from "../services/agent-resolver";

const correspondentsRouter = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

// GET /api/correspondents — ranked correspondents with signal counts, streaks, and names
correspondentsRouter.get("/api/correspondents", async (c) => {
  const rows = await listCorrespondents(c.env);

  // Resolve agent display names in parallel
  const addresses = rows.map((r) => r.btc_address);
  const nameMap = await resolveAgentNames(c.env.NEWS_KV, addresses);

  const correspondents = rows.map((row) => ({
    ...row,
    display_name: nameMap.get(row.btc_address) ?? null,
  }));

  return c.json({ correspondents, total: correspondents.length });
});

// OPTIONS — CORS preflight
correspondentsRouter.options("/api/correspondents", (c) =>
  new Response(null, { status: 204 })
);

export { correspondentsRouter };
