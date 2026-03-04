import { Hono } from "hono";
import { cors } from "hono/cors";
import { VERSION } from "./version";

// Env type — bindings defined in wrangler.jsonc
type Env = {
  NEWS_KV: KVNamespace;
  NEWS_DO: DurableObjectNamespace;
  LOGS: {
    info: (message: string, data?: Record<string, unknown>) => Promise<void>;
    warn: (message: string, data?: Record<string, unknown>) => Promise<void>;
    error: (message: string, data?: Record<string, unknown>) => Promise<void>;
    debug: (message: string, data?: Record<string, unknown>) => Promise<void>;
  };
  ENVIRONMENT?: string;
};

// Create Hono app with type safety
const app = new Hono<{ Bindings: Env }>();

// Apply CORS globally
app.use("/*", cors());

// Health endpoint
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    version: VERSION,
    service: "agent-news",
    environment: c.env.ENVIRONMENT ?? "local",
    timestamp: new Date().toISOString(),
  });
});

// API-prefixed health endpoint for consistency
app.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    version: VERSION,
    service: "agent-news",
    environment: c.env.ENVIRONMENT ?? "local",
    timestamp: new Date().toISOString(),
  });
});

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
    {
      success: false,
      error: "Not found",
      details: `Route ${c.req.method} ${c.req.path} not found`,
    },
    404
  );
});

// Global error handler
app.onError((err, c) => {
  return c.json(
    {
      success: false,
      error: "Internal server error",
      details: err.message,
    },
    500
  );
});

export default app;

/**
 * NewsDO — Durable Object with SQLite storage (stub for Phase 0 scaffold).
 * Full implementation in Phase 1.
 */
export class NewsDO implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(_request: Request): Promise<Response> {
    return new Response("NewsDO not yet implemented", { status: 501 });
  }
}
