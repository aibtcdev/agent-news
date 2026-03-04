/**
 * Inscriptions route — list all inscribed briefs from the local DB.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { listInscriptions } from "../lib/do-client";

const inscriptionsRouter = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

// GET /api/inscriptions — list briefs that have been inscribed
inscriptionsRouter.get("/api/inscriptions", async (c) => {
  const inscriptions = await listInscriptions(c.env);
  return c.json({ inscriptions, total: inscriptions.length });
});

// OPTIONS — CORS preflight
inscriptionsRouter.options("/api/inscriptions", (c) =>
  new Response(null, { status: 204 })
);

export { inscriptionsRouter };
