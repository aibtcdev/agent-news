import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { createRateLimitMiddleware } from "../middleware/rate-limit";
import { BEAT_RATE_LIMIT } from "../lib/constants";
import { validateSlug, validateHexColor, validateBtcAddress, sanitizeString } from "../lib/validators";
import { listBeats, getBeat, createBeat, updateBeat, deleteBeat } from "../lib/do-client";
import { verifyAuth } from "../services/auth";

const beatsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const beatRateLimit = createRateLimitMiddleware({
  key: "beats",
  ...BEAT_RATE_LIMIT,
});

// GET /api/beats — list all beats
beatsRouter.get("/api/beats", async (c) => {
  const beats = await listBeats(c.env);

  // Transform snake_case → camelCase to match frontend expectations
  const transformed = beats.map((b) => ({
    slug: b.slug,
    name: b.name,
    description: b.description,
    color: b.color,
    claimedBy: b.created_by,
    claimedAt: b.created_at,
    status: b.status,
    members: (b.members ?? []).map((m) => ({
      address: m.btc_address,
      claimedAt: m.claimed_at,
    })),
  }));

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json(transformed);
});

// GET /api/beats/:slug — get a single beat by slug
beatsRouter.get("/api/beats/:slug", async (c) => {
  const slug = c.req.param("slug");
  const b = await getBeat(c.env, slug);
  if (!b) {
    return c.json({ error: `Beat "${slug}" not found` }, 404);
  }
  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({
    slug: b.slug,
    name: b.name,
    description: b.description,
    color: b.color,
    claimedBy: b.created_by,
    claimedAt: b.created_at,
    status: b.status,
    members: (b.members ?? []).map((m) => ({
      address: m.btc_address,
      claimedAt: m.claimed_at,
    })),
  });
});

// POST /api/beats — create a new beat (rate limited, BIP-322 auth required)
beatsRouter.post("/api/beats", beatRateLimit, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { slug, name, description, color, created_by } = body;

  if (!slug || !name || !created_by) {
    return c.json(
      { error: "Missing required fields: slug, name, created_by" },
      400
    );
  }

  if (!validateSlug(slug)) {
    return c.json(
      { error: "Invalid slug (a-z0-9 + hyphens, 3-50 chars)" },
      400
    );
  }

  if (!validateBtcAddress(created_by)) {
    return c.json(
      { error: "Invalid BTC address format (expected bech32 bc1...)" },
      400
    );
  }

  if (color !== undefined && color !== null && !validateHexColor(color)) {
    return c.json({ error: "Invalid color format (expected #RRGGBB)" }, 400);
  }

  // BIP-322 auth: verify signature from created_by address
  const authResult = verifyAuth(c.req.raw.headers, created_by as string, "POST", "/api/beats");
  if (!authResult.valid) {
    const logger = c.get("logger");
    logger.warn("auth failure on POST /api/beats", {
      code: authResult.code,
      btc_address: created_by,
    });
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  const result = await createBeat(c.env, {
    slug: slug as string,
    name: sanitizeString(name, 100),
    description: description ? sanitizeString(description, 500) : null,
    color: color ? (color as string) : null,
    created_by: created_by as string,
  });

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  const logger = c.get("logger");
  logger.info("beat created", {
    slug: slug as string,
    created_by: created_by as string,
  });
  return c.json(result.data, 201);
});

// PATCH /api/beats/:slug — update a beat (rate limited, BIP-322 auth required)
beatsRouter.patch("/api/beats/:slug", beatRateLimit, async (c) => {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "Missing route parameter: slug" }, 400);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // btc_address is required in the body for auth
  const { btc_address } = body;
  if (!btc_address) {
    return c.json({ error: "Missing required field: btc_address" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json(
      { error: "Invalid BTC address format (expected bech32 bc1...)" },
      400
    );
  }

  if (body.color !== undefined && body.color !== null && !validateHexColor(body.color)) {
    return c.json({ error: "Invalid color format (expected #RRGGBB)" }, 400);
  }

  // BIP-322 auth: verify signature from btc_address
  const authResult = verifyAuth(
    c.req.raw.headers,
    btc_address as string,
    "PATCH",
    `/api/beats/${slug}`
  );
  if (!authResult.valid) {
    const logger = c.get("logger");
    logger.warn("auth failure on PATCH /api/beats/:slug", {
      code: authResult.code,
      btc_address,
      slug,
    });
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  // Ownership check: ensure the authenticated address owns the beat
  const existingBeat = await getBeat(c.env, slug);
  if (!existingBeat) {
    return c.json({ error: `Beat "${slug}" not found` }, 404);
  }
  if (existingBeat.created_by !== btc_address) {
    return c.json({ error: "Forbidden: you do not own this beat" }, 403);
  }

  const result = await updateBeat(c.env, slug, body);

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  return c.json(result.data);
});

// DELETE /api/beats/:slug — delete a beat (Publisher-only, BIP-322 auth required)
beatsRouter.delete("/api/beats/:slug", beatRateLimit, async (c) => {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "Missing route parameter: slug" }, 400);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { btc_address } = body;
  if (!btc_address) {
    return c.json({ error: "Missing required field: btc_address" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json(
      { error: "Invalid BTC address format (expected bech32 bc1...)" },
      400
    );
  }

  // BIP-322 auth: verify signature from btc_address
  const authResult = verifyAuth(
    c.req.raw.headers,
    btc_address as string,
    "DELETE",
    `/api/beats/${slug}`
  );
  if (!authResult.valid) {
    const logger = c.get("logger");
    logger.warn("auth failure on DELETE /api/beats/:slug", {
      code: authResult.code,
      btc_address,
      slug,
    });
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  const result = await deleteBeat(c.env, slug, btc_address as string);

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  const logger = c.get("logger");
  logger.info("beat deleted", { slug, deleted_by: btc_address });
  return c.json(result.data);
});

export { beatsRouter };
