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
import { signalPageRouter } from "./routes/signal-page";
import { configRouter } from "./routes/config";
import { signalReviewRouter } from "./routes/signal-review";

// Create Hono app with type safety
const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Apply CORS globally (matches x402-api pattern)
app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
		allowHeaders: [
			// x402 payment headers
			"payment-signature",
			"payment-required",
			"X-PAYMENT",
			// Auth headers
			"X-BTC-Address",
			"X-BTC-Signature",
			"X-BTC-Timestamp",
			// Standard
			"Content-Type",
		],
		exposeHeaders: ["payment-required", "payment-response"],
	}),
);

// Apply logger middleware globally (creates request-scoped logger + requestId)
app.use("*", loggerMiddleware);

// Mount API manifest first (GET /api)
app.route("/", manifestRouter);

// Mount beats routes
app.route("/", beatsRouter);

// Mount config routes (publisher designation)
app.route("/", configRouter);

// Mount signal detail page (HTML) before API signals route
app.route("/", signalPageRouter);

// Mount signal review routes (publisher editorial + front page) before generic signals
app.route("/", signalReviewRouter);

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
