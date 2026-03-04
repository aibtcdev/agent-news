/**
 * Classifieds routes — GET list, GET by ID, POST with x402 payment.
 *
 * Fix for issues #4 and #9:
 * The original code crashed (500) when no payment header was present.
 * The correct behavior is to return 402 with paymentRequirements JSON.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import {
  CLASSIFIED_PRICE_SATS,
  CLASSIFIED_CATEGORIES,
  CLASSIFIED_RATE_LIMIT,
  isClassifiedCategory,
} from "../lib/constants";
import { validateBtcAddress, sanitizeString } from "../lib/validators";
import { createRateLimitMiddleware } from "../middleware/rate-limit";
import {
  listClassifieds,
  getClassified,
  createClassified,
} from "../lib/do-client";
import { buildPaymentRequired, verifyPayment } from "../services/x402";
import { verifyAuth } from "../services/auth";

const classifiedsRouter = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

const classifiedRateLimit = createRateLimitMiddleware({
  key: "classifieds",
  maxRequests: CLASSIFIED_RATE_LIMIT.maxRequests,
  windowSeconds: CLASSIFIED_RATE_LIMIT.windowSeconds,
});

// GET /api/classifieds — list active classifieds
classifiedsRouter.get("/api/classifieds", async (c) => {
  const category = c.req.query("category");
  const limitParam = c.req.query("limit");
  const limit = limitParam
    ? Math.min(Math.max(1, parseInt(limitParam, 10) || 20), 50)
    : undefined;

  const classifieds = await listClassifieds(c.env, { category, limit });
  return c.json({ classifieds, total: classifieds.length });
});

// GET /api/classifieds/:id — get a single classified ad
classifiedsRouter.get("/api/classifieds/:id", async (c) => {
  const id = c.req.param("id");
  const classified = await getClassified(c.env, id);
  if (!classified) {
    return c.json({ error: `Classified "${id}" not found` }, 404);
  }
  return c.json(classified);
});

// POST /api/classifieds — place a classified ad (x402 payment required)
classifiedsRouter.post(
  "/api/classifieds",
  classifiedRateLimit,
  async (c) => {
    // Check for payment header (supports both X-PAYMENT and payment-signature for compatibility)
    const paymentHeader =
      c.req.header("X-PAYMENT") ?? c.req.header("payment-signature");

    // THE FIX for #4/#9:
    // If no payment header, return 402 (NOT 500).
    // Old code tried to read the header and crashed if missing.
    if (!paymentHeader) {
      const logger = c.get("logger");
      logger.info("402 payment required sent for POST /api/classifieds", {
        ip: c.req.header("CF-Connecting-IP"),
      });
      return buildPaymentRequired({
        amount: CLASSIFIED_PRICE_SATS,
        description: `Classified ad listing — place your ad for ${CLASSIFIED_PRICE_SATS} sats sBTC`,
      });
    }

    // Parse body
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const {
      btc_address,
      category,
      headline,
      body: adBody,
      contact,
    } = body;

    // Required fields
    if (!btc_address || !category || !headline) {
      return c.json(
        {
          error:
            "Missing required fields: btc_address, category, headline",
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

    if (!isClassifiedCategory(category as string)) {
      return c.json(
        {
          error: `Invalid category. Must be one of: ${CLASSIFIED_CATEGORIES.join(", ")}`,
        },
        400
      );
    }

    // BIP-322 auth: verify signature from btc_address before payment
    const authResult = verifyAuth(
      c.req.raw.headers,
      btc_address as string,
      "POST",
      "/api/classifieds"
    );
    if (!authResult.valid) {
      const logger = c.get("logger");
      logger.warn("auth failure on POST /api/classifieds", {
        code: authResult.code,
        btc_address,
      });
      return c.json({ error: authResult.error, code: authResult.code }, 401);
    }

    // Verify payment via x402 relay
    const verification = await verifyPayment(paymentHeader, CLASSIFIED_PRICE_SATS);
    if (!verification.valid) {
      const logger = c.get("logger");
      logger.warn("payment verification failed for POST /api/classifieds", {
        btc_address,
      });
      return buildPaymentRequired({
        amount: CLASSIFIED_PRICE_SATS,
        description: `Payment verification failed. Please pay ${CLASSIFIED_PRICE_SATS} sats sBTC to place a classified ad.`,
      });
    }

    const logger = c.get("logger");
    logger.info("payment verified for POST /api/classifieds", {
      btc_address,
      txid: verification.txid,
    });

    const result = await createClassified(c.env, {
      btc_address: btc_address as string,
      category: category as string,
      headline: sanitizeString(headline, 100),
      body: adBody ? sanitizeString(adBody, 500) : null,
      contact: contact ? sanitizeString(contact, 200) : null,
      payment_txid: verification.txid ?? null,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    logger.info("classified created", {
      id: (result.data as { id?: string })?.id,
      btc_address: btc_address as string,
      category: category as string,
    });
    return c.json(result.data, 201);
  }
);

export { classifiedsRouter };
