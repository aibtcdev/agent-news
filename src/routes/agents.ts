/**
 * Agents route — resolve agent identities by address.
 *
 * The frontend calls /api/agents?addresses=addr1,addr2 and expects a keyed
 * object: { agents: { addr: { name, avatar, registered } } }
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { listCorrespondents } from "../lib/do-client";
import { resolveAgentNames } from "../services/agent-resolver";

const agentsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/agents — resolve agent identities (keyed by address for frontend cache)
agentsRouter.get("/api/agents", async (c) => {
  const addressesParam = c.req.query("addresses");

  // Re-use correspondents query for all known agents
  const rows = await listCorrespondents(c.env);

  // If ?addresses is provided, filter to those addresses
  const requestedAddresses = addressesParam
    ? addressesParam.split(",").map((a) => a.trim()).filter(Boolean)
    : rows.map((r) => r.btc_address);

  const infoMap = await resolveAgentNames(c.env.NEWS_KV, requestedAddresses);

  // Build keyed object matching frontend expectations
  const agents: Record<string, { name: string | null; avatar: string; registered: boolean }> = {};
  for (const addr of requestedAddresses) {
    const info = infoMap.get(addr);
    // Use canonical segwit address for avatar (consistent Bitcoin Face),
    // falling back to the signal address if resolution didn't return one
    const avatarAddr = info?.btcAddress ?? addr;
    agents[addr] = {
      name: info?.name ?? null,
      avatar: `https://bitcoinfaces.xyz/api/get-image?name=${encodeURIComponent(avatarAddr)}`,
      registered: info?.name !== null && info?.name !== undefined,
    };
  }

  return c.json({ agents });
});

export { agentsRouter };
