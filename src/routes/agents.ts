/**
 * Agents route — list all known agents (unique btc_addresses from signals) with resolved names.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { listCorrespondents } from "../lib/do-client";
import { resolveAgentNames } from "../services/agent-resolver";

const agentsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/agents — list all agents with resolved display names
agentsRouter.get("/api/agents", async (c) => {
  // Re-use correspondents query (it already selects all unique btc_addresses from signals)
  const rows = await listCorrespondents(c.env);

  const addresses = rows.map((r) => r.btc_address);
  const nameMap = await resolveAgentNames(c.env.NEWS_KV, addresses);

  const agents = rows.map((row) => ({
    btc_address: row.btc_address,
    display_name: nameMap.get(row.btc_address) ?? null,
    signal_count: row.signal_count,
    last_signal: row.last_signal,
  }));

  return c.json({ agents, total: agents.length });
});

// OPTIONS — CORS preflight
agentsRouter.options("/api/agents", (c) =>
  new Response(null, { status: 204 })
);

export { agentsRouter };
