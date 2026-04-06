/**
 * Beat editor management routes.
 *
 * POST   /api/beats/:slug/editors          — Publisher registers an editor for a beat
 * DELETE /api/beats/:slug/editors/:address — Publisher deactivates an editor
 * GET    /api/beats/:slug/editors          — List active editors for a beat (public)
 * GET    /api/editors/:address             — List beats an editor is assigned to (public)
 */

import { Hono } from "hono";
import type { Env, AppVariables, BeatEditor } from "../lib/types";
import { validateBtcAddress } from "../lib/validators";
import { verifyAuth } from "../services/auth";
import {
  registerBeatEditor,
  deactivateBeatEditor,
  listBeatEditors,
  listEditorBeats,
} from "../lib/do-client";

const beatEditorsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// POST /api/beats/:slug/editors — Publisher registers an editor for a beat
beatEditorsRouter.post("/api/beats/:slug/editors", async (c) => {
  const slug = c.req.param("slug");

  // Publisher address from auth header
  const publisherAddress = c.req.header("X-BTC-Address");
  if (!publisherAddress) {
    return c.json(
      { error: "Missing authentication headers: X-BTC-Address, X-BTC-Signature, X-BTC-Timestamp", code: "MISSING_AUTH" },
      401
    );
  }
  if (!validateBtcAddress(publisherAddress)) {
    return c.json({ error: "Invalid BTC address in X-BTC-Address header" }, 400);
  }

  const authResult = verifyAuth(
    c.req.raw.headers,
    publisherAddress,
    "POST",
    `/api/beats/${slug}/editors`
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

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
    return c.json({ error: "Invalid BTC address format" }, 400);
  }

  const result = await registerBeatEditor(c.env, slug, {
    btc_address: btc_address as string,
    registered_by: publisherAddress,
  });

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  const logger = c.get("logger");
  logger.info("beat editor registered", {
    beat_slug: slug,
    editor: btc_address,
    registered_by: publisherAddress,
  });

  return c.json(result.data as BeatEditor, 201);
});

// DELETE /api/beats/:slug/editors/:address — Publisher deactivates an editor
beatEditorsRouter.delete("/api/beats/:slug/editors/:address", async (c) => {
  const slug = c.req.param("slug");
  const address = c.req.param("address");

  const publisherAddress = c.req.header("X-BTC-Address");
  if (!publisherAddress) {
    return c.json(
      { error: "Missing authentication headers: X-BTC-Address, X-BTC-Signature, X-BTC-Timestamp", code: "MISSING_AUTH" },
      401
    );
  }
  if (!validateBtcAddress(publisherAddress)) {
    return c.json({ error: "Invalid BTC address in X-BTC-Address header" }, 400);
  }

  if (!validateBtcAddress(address)) {
    return c.json({ error: "Invalid BTC address in path" }, 400);
  }

  const authResult = verifyAuth(
    c.req.raw.headers,
    publisherAddress,
    "DELETE",
    `/api/beats/${slug}/editors/${address}`
  );
  if (!authResult.valid) {
    return c.json({ error: authResult.error, code: authResult.code }, 401);
  }

  const result = await deactivateBeatEditor(c.env, slug, address, publisherAddress);

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  const logger = c.get("logger");
  logger.info("beat editor deactivated", {
    beat_slug: slug,
    editor: address,
    deactivated_by: publisherAddress,
  });

  return c.json(result.data);
});

// GET /api/beats/:slug/editors — List active editors for a beat (public)
beatEditorsRouter.get("/api/beats/:slug/editors", async (c) => {
  const slug = c.req.param("slug");
  const result = await listBeatEditors(c.env, slug);

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json(result.data);
});

// GET /api/editors/:address — List beats an editor is assigned to (public)
beatEditorsRouter.get("/api/editors/:address", async (c) => {
  const address = c.req.param("address");

  if (!validateBtcAddress(address)) {
    return c.json({ error: "Invalid BTC address format" }, 400);
  }

  const result = await listEditorBeats(c.env, address);

  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json(result.data);
});

export { beatEditorsRouter };
