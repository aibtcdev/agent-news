import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { createRateLimitMiddleware } from "../middleware/rate-limit";
import { BRIEF_INSCRIBE_RATE_LIMIT } from "../lib/constants";
import { getBriefByDate, updateBrief } from "../lib/do-client";
import { validateBtcAddress, validateSignatureFormat } from "../lib/validators";
import { verifyAuth } from "../services/auth";

const briefInscribeRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const inscribeRateLimit = createRateLimitMiddleware({
  key: "brief-inscribe",
  ...BRIEF_INSCRIBE_RATE_LIMIT,
  identityHeader: "X-BTC-Address",
});

/** Validate inscription ID: {64-char txid}i{index} or numeric ordinal number */
function validateInscriptionId(id: string): boolean {
  return /^[a-f0-9]{64}i\d+$/.test(id) || /^\d+$/.test(id);
}

/**
 * POST /api/brief/:date/inscribe — report that a brief has been inscribed.
 * Body: { btc_address, signature, inscription_id, inscribed_txid? }
 */
briefInscribeRouter.post(
  "/api/brief/:date/inscribe",
  inscribeRateLimit,
  async (c) => {
    const date = c.req.param("date");
    if (!date) return c.json({ error: "Missing route parameter: date" }, 400);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: "Invalid date format", hint: "Use YYYY-MM-DD" }, 400);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { btc_address, signature, inscription_id, inscribed_txid } = body;

    if (!btc_address || !signature || !inscription_id) {
      return c.json(
        {
          error: "Missing required fields: btc_address, signature, inscription_id",
        },
        400
      );
    }

    if (!validateBtcAddress(btc_address)) {
      return c.json(
        { error: "Invalid BTC address format (expected bech32 bc1...)" },
        400
      );
    }

    const authResult = verifyAuth(c.req.raw.headers, btc_address as string, "POST", `/api/brief/${date}/inscribe`);
    if (!authResult.valid) {
      const logger = c.get("logger");
      logger.warn("auth failure on POST /api/brief/:date/inscribe", {
        code: authResult.code,
        btc_address,
        date,
      });
      return c.json({ error: authResult.error ?? "Unauthorized" }, 401);
    }

    if (!validateSignatureFormat(signature)) {
      return c.json(
        { error: "Invalid signature format (expected base64, 20-200 chars)" },
        401
      );
    }

    if (!validateInscriptionId(inscription_id as string)) {
      return c.json(
        {
          error: "Invalid inscription ID format",
          hint: "Expected {txid}i{index} (e.g. abc123...i0) or numeric ordinal number",
        },
        400
      );
    }

    // Load the brief
    const brief = await getBriefByDate(c.env, date);
    if (!brief) {
      return c.json({ error: `No brief found for ${date}` }, 404);
    }

    // Check if already inscribed
    if (brief.inscription_id) {
      return c.json(
        {
          error: `Brief for ${date} is already inscribed (${brief.inscription_id})`,
        },
        409
      );
    }

    // Update the brief with inscription data
    const result = await updateBrief(c.env, date, {
      inscription_id: inscription_id as string,
      inscribed_txid: inscribed_txid ? (inscribed_txid as string) : null,
    });

    if (!result.ok) {
      return c.json({ error: result.error ?? "Failed to update brief" }, 500);
    }

    const logger = c.get("logger");
    logger.info("brief inscribed", {
      date,
      inscription_id: inscription_id as string,
      btc_address,
    });
    return c.json(
      {
        ok: true,
        date,
        inscription_id: inscription_id as string,
        inscribed_txid: inscribed_txid ?? null,
        ordinal_link: `https://ordinals.com/inscription/${inscription_id as string}`,
      },
      201
    );
  }
);

/**
 * PATCH /api/brief/:date/inscribe — update inscription fields (txid, id) after confirmation.
 * Body: { inscribed_txid?, inscription_id? }
 */
briefInscribeRouter.patch("/api/brief/:date/inscribe", async (c) => {
  const date = c.req.param("date");
  if (!date) return c.json({ error: "Missing route parameter: date" }, 400);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "Invalid date format", hint: "Use YYYY-MM-DD" }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { btc_address, inscribed_txid, inscription_id } = body;

  if (!btc_address || typeof btc_address !== "string") {
    return c.json({ error: "Missing required field: btc_address" }, 400);
  }

  if (!validateBtcAddress(btc_address)) {
    return c.json(
      { error: "Invalid BTC address format (expected bech32 bc1...)" },
      400
    );
  }

  const authResult = verifyAuth(c.req.raw.headers, btc_address, "PATCH", `/api/brief/${date}/inscribe`);
  if (!authResult.valid) {
    const logger = c.get("logger");
    logger.warn("auth failure on PATCH /api/brief/:date/inscribe", {
      code: authResult.code,
      btc_address,
      date,
    });
    return c.json({ error: authResult.error ?? "Unauthorized" }, 401);
  }

  if (inscribed_txid === undefined && inscription_id === undefined) {
    return c.json(
      { error: "Must provide at least one field: inscribed_txid, inscription_id" },
      400
    );
  }

  if (inscription_id !== undefined && !validateInscriptionId(inscription_id as string)) {
    return c.json(
      {
        error: "Invalid inscription ID format",
        hint: "Expected {txid}i{index} or numeric ordinal number",
      },
      400
    );
  }

  const brief = await getBriefByDate(c.env, date);
  if (!brief) {
    return c.json({ error: `No brief found for ${date}` }, 404);
  }

  const result = await updateBrief(c.env, date, {
    inscribed_txid: inscribed_txid !== undefined ? (inscribed_txid as string | null) : undefined,
    inscription_id: inscription_id !== undefined ? (inscription_id as string | null) : undefined,
  });

  if (!result.ok) {
    return c.json({ error: result.error ?? "Failed to update brief" }, 500);
  }

  return c.json({ ok: true, date, brief: result.data });
});

/**
 * GET /api/brief/:date/inscription — get inscription status for a brief
 */
briefInscribeRouter.get("/api/brief/:date/inscription", async (c) => {
  const date = c.req.param("date");
  if (!date) return c.json({ error: "Missing route parameter: date" }, 400);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "Invalid date format", hint: "Use YYYY-MM-DD" }, 400);
  }

  const brief = await getBriefByDate(c.env, date);
  if (!brief) {
    return c.json({ error: `No brief found for ${date}` }, 404);
  }

  if (!brief.inscription_id) {
    return c.json({ date, inscribed: false });
  }

  return c.json({
    date,
    inscribed: true,
    inscription_id: brief.inscription_id,
    inscribed_txid: brief.inscribed_txid ?? null,
    ordinal_link: `https://ordinals.com/inscription/${brief.inscription_id}`,
  });
});

export { briefInscribeRouter };
