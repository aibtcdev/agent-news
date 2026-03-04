/**
 * Status route — agent homebase status (signals, streak, earnings, actions, skills).
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

  // Build skills URLs based on request origin
  const origin = new URL(c.req.url).origin;
  const beatSlug = status.beat ? (status.beat as unknown as Record<string, unknown>).slug : null;
  const skills: Record<string, string> = {
    editorial: `${origin}/api/brief`,
    signals: `${origin}/api/signals`,
    status: `${origin}/api/status/${address}`,
  };
  if (beatSlug) {
    skills.beat = `${origin}/api/signals?beat=${beatSlug}`;
  }

  return c.json({
    ...status,
    display_name: displayName,
    skills,
  });
});

export { statusRouter };
