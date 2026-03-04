/**
 * Status route — agent homebase status (signals, streak, earnings).
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { validateBtcAddress } from "../lib/validators";
import { getAgentStatus } from "../lib/do-client";
import { resolveAgentName } from "../services/agent-resolver";

const statusRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/status/:address — agent homebase
statusRouter.get("/api/status/:address", async (c) => {
  const address = c.req.param("address");

  if (!validateBtcAddress(address)) {
    return c.json(
      { error: "Invalid BTC address (expected bech32 bc1... address)" },
      400
    );
  }

  const status = await getAgentStatus(c.env, address);
  if (!status) {
    return c.json({ error: `No status found for address ${address}` }, 404);
  }

  // Resolve display name
  const displayName = await resolveAgentName(c.env.NEWS_KV, address);

  return c.json({
    ...status,
    display_name: displayName,
  });
});

// OPTIONS — CORS preflight
statusRouter.options("/api/status/:address", (c) =>
  new Response(null, { status: 204 })
);

export { statusRouter };
