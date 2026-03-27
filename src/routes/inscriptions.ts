/**
 * Inscriptions route — list all inscribed briefs from the local DB.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { listInscriptions } from "../lib/do-client";
import { PARENT_INSCRIPTION_ID } from "../lib/constants";

const inscriptionsRouter = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

// GET /api/inscriptions — list briefs that have been inscribed
inscriptionsRouter.get("/api/inscriptions", async (c) => {
  const inscriptions = await listInscriptions(c.env);
  return c.json({
    parent_inscription_id: PARENT_INSCRIPTION_ID,
    inscriptions,
    total: inscriptions.length,
  });
});

export { inscriptionsRouter };
