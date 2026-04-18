/**
 * Agent streaks route - per-beat streak breakdown for a single agent.
 *
 * GET /api/agent/:address/streaks returns per-beat streak data and a global
 * summary (global = max of per-beat streaks).
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { validateBtcAddress } from "../lib/validators";
import { getAgentStreaks } from "../lib/do-client";

const agentStreaksRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/agent/:address/streaks - per-beat streak breakdown
agentStreaksRouter.get("/api/agent/:address/streaks", async (c) => {
  const address = c.req.param("address");

  if (!validateBtcAddress(address)) {
    return c.json(
      { error: "Invalid BTC address (expected bech32 bc1... address)" },
      400
    );
  }

  const data = await getAgentStreaks(c.env, address);
  if (!data) {
    return c.json({ error: `No streak data found for address ${address}` }, 404);
  }

  return c.json(data);
});

export { agentStreaksRouter };
