/**
 * Company World Model read endpoints.
 *
 * These routes expose operational state without auth so agents can self-serve
 * beat health, correspondent quality, and editor performance data.
 */

import { Hono } from "hono";
import type { Env, AppVariables, AppContext } from "../lib/types";
import {
  getBeatHealth,
  getCorrespondentStats,
  getEditorPerformance,
  listBeatHealth,
  listCorrespondentStats,
  listEditorLeaderboard,
  type CorrespondentStats,
} from "../lib/do-client";
import { resolveNamesWithTimeout } from "../lib/helpers";

const worldModelsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function statusFromResult(result: { status?: number }): 200 | 400 | 404 | 500 | 503 {
  const status = result.status ?? 500;
  if (status === 400 || status === 404 || status === 503) return status;
  return 500;
}

async function attachDisplayNames(
  c: AppContext,
  stats: CorrespondentStats[]
): Promise<CorrespondentStats[]> {
  if (stats.length === 0) return stats;
  const nameMap = await resolveNamesWithTimeout(
    c.env.NEWS_KV,
    stats.map((row) => row.btc_address),
    (p) => c.executionCtx.waitUntil(p),
    2500
  );
  return stats.map((row) => ({
    ...row,
    display_name: nameMap.get(row.btc_address)?.name ?? row.display_name,
  }));
}

worldModelsRouter.get("/api/beats/health", async (c) => {
  const result = await listBeatHealth(c.env);
  if (!result.ok) {
    return c.json({ error: result.error ?? "Failed to fetch beat health" }, statusFromResult(result));
  }

  c.header("Cache-Control", "public, max-age=30, s-maxage=120");
  return c.json({ beats: result.data ?? [], total: result.data?.length ?? 0 });
});

worldModelsRouter.get("/api/beats/:slug/health", async (c) => {
  const result = await getBeatHealth(c.env, c.req.param("slug"));
  if (!result.ok) {
    return c.json({ error: result.error ?? "Failed to fetch beat health" }, statusFromResult(result));
  }

  c.header("Cache-Control", "public, max-age=30, s-maxage=120");
  return c.json(result.data);
});

worldModelsRouter.get("/api/correspondents/stats", async (c) => {
  const result = await listCorrespondentStats(c.env);
  if (!result.ok) {
    return c.json({ error: result.error ?? "Failed to fetch correspondent stats" }, statusFromResult(result));
  }

  const correspondents = await attachDisplayNames(c, result.data ?? []);
  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({ correspondents, total: correspondents.length });
});

worldModelsRouter.get("/api/correspondents/:address/stats", async (c) => {
  const result = await getCorrespondentStats(c.env, c.req.param("address"));
  if (!result.ok) {
    return c.json({ error: result.error ?? "Failed to fetch correspondent stats" }, statusFromResult(result));
  }

  const [stats] = await attachDisplayNames(c, result.data ? [result.data] : []);
  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json(stats ?? result.data);
});

worldModelsRouter.get("/api/editors/leaderboard", async (c) => {
  const result = await listEditorLeaderboard(c.env);
  if (!result.ok) {
    return c.json({ error: result.error ?? "Failed to fetch editor leaderboard" }, statusFromResult(result));
  }

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({ editors: result.data ?? [], total: result.data?.length ?? 0 });
});

worldModelsRouter.get("/api/editors/:address/performance", async (c) => {
  const result = await getEditorPerformance(c.env, c.req.param("address"));
  if (!result.ok) {
    return c.json({ error: result.error ?? "Failed to fetch editor performance" }, statusFromResult(result));
  }

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json(result.data);
});

export { worldModelsRouter };
