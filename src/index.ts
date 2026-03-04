import { Hono } from "hono";
import { cors } from "hono/cors";
import { VERSION } from "./version";
import type { Env, AppVariables, AppContext } from "./lib/types";
import { loggerMiddleware } from "./middleware";
import { beatsRouter } from "./routes/beats";
import { signalsRouter } from "./routes/signals";
import { briefRouter } from "./routes/brief";
import { briefCompileRouter } from "./routes/brief-compile";
import { briefInscribeRouter } from "./routes/brief-inscribe";
import { classifiedsRouter } from "./routes/classifieds";
import { correspondentsRouter } from "./routes/correspondents";
import { streaksRouter } from "./routes/streaks";
import { statusRouter } from "./routes/status";
import { skillsRouter } from "./routes/skills";
import { agentsRouter } from "./routes/agents";
import { inscriptionsRouter } from "./routes/inscriptions";
import { reportRouter } from "./routes/report";
import { manifestRouter } from "./routes/manifest";
import { migrateEntities, getMigrationStatus, type MigrateEntityType } from "./lib/do-client";

// Create Hono app with type safety
const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Apply CORS globally
app.use("/*", cors());

// Apply logger middleware globally (creates request-scoped logger + requestId)
app.use("*", loggerMiddleware);

// Mount API manifest first (GET /api)
app.route("/", manifestRouter);

// Mount beats routes
app.route("/", beatsRouter);

// Mount signals routes
app.route("/", signalsRouter);

// Mount brief routes (compile before generic brief to avoid :date matching /compile)
app.route("/", briefCompileRouter);
app.route("/", briefRouter);
app.route("/", briefInscribeRouter);

// Mount classifieds routes
app.route("/", classifiedsRouter);

// Mount read-only routes
app.route("/", correspondentsRouter);
app.route("/", streaksRouter);
app.route("/", statusRouter);
app.route("/", skillsRouter);
app.route("/", agentsRouter);
app.route("/", inscriptionsRouter);
app.route("/", reportRouter);

// -------------------------------------------------------------------------
// Internal migration endpoints — proxy to DO /migrate
// These are internal-only routes for the KV-to-DO migration script.
// -------------------------------------------------------------------------

// POST /api/internal/migrate — bulk import entity records into the DO
app.post("/api/internal/migrate", async (c) => {
  const migrationKey = c.env.MIGRATION_KEY;
  if (!migrationKey) {
    return c.json({ error: "Migration not configured" }, 503);
  }
  const providedKey = c.req.header("X-Migration-Key");
  if (!providedKey || providedKey !== migrationKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { type, records } = body;
  if (!type || !Array.isArray(records)) {
    return c.json({ error: "Missing required fields: type (string), records (array)" }, 400);
  }

  const result = await migrateEntities(c.env, type as MigrateEntityType, records as Record<string, unknown>[]);
  if (!result.ok) {
    return c.json({ error: result.error }, 400);
  }
  return c.json(result.data);
});

// GET /api/internal/migrate/status — get row counts from the DO (read-only)
app.get("/api/internal/migrate/status", async (c) => {
  const migrationKey = c.env.MIGRATION_KEY;
  if (!migrationKey) {
    return c.json({ error: "Migration not configured" }, 503);
  }
  const providedKey = c.req.header("X-Migration-Key");
  if (!providedKey || providedKey !== migrationKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const result = await getMigrationStatus(c.env);
  if (!result.ok) {
    return c.json({ error: result.error }, 400);
  }
  return c.json(result.data);
});

// Health endpoint (available at both /health and /api/health)
function healthHandler(c: AppContext) {
  return c.json({
    status: "ok",
    version: VERSION,
    service: "agent-news",
    environment: c.env.ENVIRONMENT ?? "local",
    timestamp: new Date().toISOString(),
  });
}

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// Root endpoint - service info
app.get("/", (c) => {
  return c.json({
    service: "agent-news",
    version: VERSION,
    description: "AI agent news aggregation and briefing service",
    endpoints: {
      health: "GET /health - Health check",
      apiHealth: "GET /api/health - API health check",
    },
    related: {
      github: "https://github.com/aibtcdev/agent-news",
    },
  });
});

// 404 handler
app.notFound((c) => {
  return c.json(
    { error: `Route ${c.req.method} ${c.req.path} not found` },
    404
  );
});

// Global error handler
app.onError((err, c) => {
  const isLocal = !c.env.ENVIRONMENT || c.env.ENVIRONMENT === "local";
  return c.json(
    {
      error: "Internal server error",
      ...(isLocal ? { details: err.message } : {}),
    },
    500
  );
});

export default app;

// Re-export NewsDO from its own module for wrangler to pick up
export { NewsDO } from "./objects/news-do";
