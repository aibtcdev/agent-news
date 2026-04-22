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
import { classifiedReviewRouter } from "./routes/classified-review";
import { classifiedsRouter } from "./routes/classifieds";
import { correspondentsRouter } from "./routes/correspondents";
import { streaksRouter } from "./routes/streaks";
import { statusRouter } from "./routes/status";
import { paymentStatusRouter } from "./routes/payment-status";
import { skillsRouter } from "./routes/skills";
import { agentsRouter } from "./routes/agents";
import { inscriptionsRouter } from "./routes/inscriptions";
import { reportRouter } from "./routes/report";
import { manifestRouter } from "./routes/manifest";
import { signalPageRouter } from "./routes/signal-page";
import { configRouter } from "./routes/config";
import { signalReviewRouter } from "./routes/signal-review";
import { signalCountsRouter } from "./routes/signal-counts";
import { correctionsRouter } from "./routes/corrections";
import { referralsRouter } from "./routes/referrals";
import { leaderboardRouter } from "./routes/leaderboard";
import { earningsRouter } from "./routes/earnings";
import { beatEditorsRouter } from "./routes/beat-editors";
import { editorEarningsRouter } from "./routes/editor-earnings";
import { initRouter } from "./routes/init";
import { seoRouter } from "./routes/seo";
import { homeRouter } from "./routes/home-page";

// Create Hono app with type safety
const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Apply CORS globally (matches x402-api pattern)
app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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
		exposeHeaders: ["payment-required", "payment-response", "x-payment-status", "x-payment-id"],
	}),
);

// Apply logger middleware globally (creates request-scoped logger + requestId)
app.use("*", loggerMiddleware);

// Mount SEO routes (robots.txt + sitemap family) early so they're not shadowed by static assets.
app.route("/", seoRouter);

// Mount homepage SSR — intercepts GET / (enabled by run_worker_first: ["/"]
// in wrangler.jsonc). Other asset paths continue serving directly.
app.route("/", homeRouter);

// Mount init bundle (single request for initial page load) before other routes
app.route("/", initRouter);

// Mount API manifest first (GET /api)
app.route("/", manifestRouter);

// Mount beat editors before beats (to avoid slug path collision with :slug/editors)
app.route("/", beatEditorsRouter);

// Mount beats routes
app.route("/", beatsRouter);

// Mount config routes (publisher designation)
app.route("/", configRouter);

// Mount signal detail page (HTML) before API signals route
app.route("/", signalPageRouter);

// Mount signal review routes (publisher editorial + front page) before generic signals
app.route("/", signalReviewRouter);

// Mount signal counts route before generic signals (avoids :id param collision)
app.route("/", signalCountsRouter);

// Mount signals routes
app.route("/", signalsRouter);

// Mount brief routes (compile before generic brief to avoid :date matching /compile)
app.route("/", briefCompileRouter);
app.route("/", briefRouter);
app.route("/", briefInscribeRouter);

// Mount classified review routes (before generic classifieds to avoid :id matching /pending)
app.route("/", classifiedReviewRouter);

// Mount classifieds routes
app.route("/", classifiedsRouter);

// Mount corrections and referrals before generic signals
app.route("/", correctionsRouter);

// Mount referrals
app.route("/", referralsRouter);

// Mount leaderboard v2
app.route("/", leaderboardRouter);

// Mount earnings routes
app.route("/", earningsRouter);

// Mount editor earnings routes (near earnings for logical grouping)
app.route("/", editorEarningsRouter);

// Mount read-only routes
app.route("/", correspondentsRouter);
app.route("/", streaksRouter);
app.route("/", statusRouter);
app.route("/", paymentStatusRouter);
app.route("/", skillsRouter);
app.route("/", agentsRouter);
app.route("/", inscriptionsRouter);
app.route("/", reportRouter);

// Staging seed endpoint — proxies to the DO's /test-seed route.
// Gated on MIGRATION_KEY header; used by CI to populate preview deployments.
app.post("/api/internal/seed", async (c) => {
  const key = c.req.header("X-Migration-Key");
  if (!key || key !== c.env.MIGRATION_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (c.env.ENVIRONMENT === "production") {
    return c.json({ error: "Not found" }, 404);
  }
  const id = c.env.NEWS_DO.idFromName("news-singleton");
  const stub = c.env.NEWS_DO.get(id);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const res = await stub.fetch("https://do/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return c.json(data, res.status as 200 | 400 | 404);
});

// ---------------------------------------------------------------------------
// Test-only DO proxy helpers
// ---------------------------------------------------------------------------

function isTestEnv(c: AppContext): boolean {
  return c.env.ENVIRONMENT === "test" || c.env.ENVIRONMENT === "development";
}

function getDoStub(c: AppContext) {
  return c.env.NEWS_DO.get(c.env.NEWS_DO.idFromName("news-singleton"));
}

async function parseJsonBody(c: AppContext): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

// Test-only seed endpoint — proxies to the DO's /test-seed route.
// Gated on ENVIRONMENT !== 'production' at both the worker and DO level.
app.post("/api/test-seed", async (c) => {
  if (!isTestEnv(c)) return c.json({ error: "Not found" }, 404);
  const body = await parseJsonBody(c);
  if (body === null) return c.json({ error: "Invalid JSON body" }, 400);
  const res = await getDoStub(c).fetch("https://do/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return c.json(await res.json(), res.status as 200 | 400 | 404);
});

app.get("/api/test/brief-signals/:date", async (c) => {
  if (!isTestEnv(c)) return c.json({ error: "Not found" }, 404);
  const res = await getDoStub(c).fetch(`https://do/brief-signals/${encodeURIComponent(c.req.param("date"))}`);
  return c.json(await res.json(), res.status as 200 | 400 | 404);
});

app.post("/api/test/payment-stage", async (c) => {
  if (!isTestEnv(c)) return c.json({ error: "Not found" }, 404);
  const body = await parseJsonBody(c);
  if (body === null) return c.json({ error: "Invalid JSON body" }, 400);
  const res = await getDoStub(c).fetch("https://do/payment-staging", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return c.json(await res.json(), res.status as 200 | 201 | 400 | 404);
});

app.get("/api/test/payment-stage/:paymentId", async (c) => {
  if (!isTestEnv(c)) return c.json({ error: "Not found" }, 404);
  const res = await getDoStub(c).fetch(`https://do/payment-staging/${encodeURIComponent(c.req.param("paymentId"))}`);
  return c.json(await res.json(), res.status as 200 | 404);
});

app.post("/api/test/payment-stage/:paymentId/reconcile", async (c) => {
  if (!isTestEnv(c)) return c.json({ error: "Not found" }, 404);
  const body = await parseJsonBody(c);
  if (body === null) return c.json({ error: "Invalid JSON body" }, 400);
  const res = await getDoStub(c).fetch(`https://do/payment-staging/${encodeURIComponent(c.req.param("paymentId"))}/reconcile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return c.json(await res.json(), res.status as 200 | 400 | 404);
});

// Test-only — mark a staged row 'expired' so tests can cover the late-settlement path.
app.post("/api/test/payment-stage/:paymentId/force-expire", async (c) => {
  if (!isTestEnv(c)) return c.json({ error: "Not found" }, 404);
  const res = await getDoStub(c).fetch(
    `https://do/test/payment-staging/${encodeURIComponent(c.req.param("paymentId"))}/force-expire`,
    { method: "POST" }
  );
  return c.json(await res.json(), res.status as 200 | 404);
});

// Test-only — trigger the staged-payment alarm sweep without waiting 50s.
// Accepts { results: { [paymentId]: { status, txid?, terminalReason? } } }
// to stub checkPayment per row. If `results` is omitted, the live X402_RELAY
// binding is used (useful for end-to-end probes).
app.post("/api/test/sweep-staged-payments", async (c) => {
  if (!isTestEnv(c)) return c.json({ error: "Not found" }, 404);
  const body = (await parseJsonBody(c)) as {
    graceMs?: number;
    limit?: number;
    results?: Record<string, { status: string; txid?: string; terminalReason?: string }>;
  } | null;
  const res = await getDoStub(c).fetch("https://do/test/sweep-staged-payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return c.json(await res.json(), res.status as 200 | 400 | 404);
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

// (The old GET / JSON service-info handler was removed — homepage SSR owns
// the root path now. Service metadata lives at /api/health.)

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
