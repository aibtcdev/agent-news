/**
 * Classifieds routes — GET list, GET by ID, POST with x402 payment.
 *
 * Fix for issues #4 and #9:
 * The original code crashed (500) when no payment header was present.
 * The correct behavior is to return 402 with paymentRequirements JSON.
 */

import { Hono } from "hono";
import type { Env, AppVariables, Classified } from "../lib/types";
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
  getClassifiedsRotation,
} from "../lib/do-client";
import { buildPaymentRequired, verifyPayment, mapVerificationError } from "../services/x402";

/** Transform a Classified row to the camelCase API response shape. */
export function transformClassified(cl: Classified) {
  return {
    id: cl.id,
    title: cl.headline,
    body: cl.body,
    category: cl.category,
    placedBy: cl.btc_address,
    paymentTxid: cl.payment_txid,
    createdAt: cl.created_at,
    expiresAt: cl.expires_at,
    active: new Date(cl.expires_at).getTime() > Date.now(),
    status: cl.status,
    publisherFeedback: cl.publisher_feedback,
    reviewedAt: cl.reviewed_at,
    refundTxid: cl.refund_txid,
  };
}

const classifiedsRouter = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

const classifiedRateLimit = createRateLimitMiddleware({
  key: "classifieds",
  skipIfMissingHeaders: ["X-PAYMENT", "payment-signature"],
  ...CLASSIFIED_RATE_LIMIT,
});

// GET /api/classifieds/rotation — random selection of up to 3 active listings for brief inclusion
classifiedsRouter.get("/api/classifieds/rotation", async (c) => {
  const maxChars = c.req.query("max_chars");
  const result = await getClassifiedsRotation(c.env, maxChars ? parseInt(maxChars, 10) : undefined);
  c.header("Cache-Control", "no-store"); // always fresh for brief compilation
  if (!result.ok) {
    return c.json({ error: "Failed to fetch classifieds rotation" }, 500);
  }
  return c.json(result);
});

// GET /api/classifieds — list classifieds
// Default: active approved ads. With ?agent=ADDRESS: all submissions for that agent.
classifiedsRouter.get("/api/classifieds", async (c) => {
  const category = c.req.query("category");
  const agent = c.req.query("agent");
  const limitParam = c.req.query("limit");
  const limit = limitParam
    ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 1000)
    : undefined;

  const classifieds = await listClassifieds(c.env, { category, agent, limit });

  const transformed = classifieds.map(transformClassified);

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({ classifieds: transformed, total: transformed.length });
});

// GET /api/classifieds/:id — get a single classified ad
classifiedsRouter.get("/api/classifieds/:id", async (c) => {
  const id = c.req.param("id");
  const cl = await getClassified(c.env, id);
  if (!cl) {
    return c.json({ error: `Classified "${id}" not found` }, 404);
  }
  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json(transformClassified(cl));
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
      logger.debug("402 payment required sent for POST /api/classifieds", {
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

    // Accept both field naming conventions: title/headline, contact/btc_address
    const headline = (body.headline ?? body.title) as string | undefined;
    const category = body.category as string | undefined;
    const adBody = (body.body as string | undefined) ?? null;

    // Required fields (btc_address derived from x402 payer after payment verification)
    if (!category || !headline) {
      return c.json(
        {
          error:
            "Missing required fields: category, title (or headline)",
        },
        400
      );
    }

    if (!isClassifiedCategory(category)) {
      return c.json(
        {
          error: `Invalid category. Must be one of: ${CLASSIFIED_CATEGORIES.join(", ")}`,
        },
        400
      );
    }

    // Verify payment via x402 relay
    const verification = await verifyPayment(paymentHeader, CLASSIFIED_PRICE_SATS, c.env);
    if (!verification.valid) {
      const logger = c.get("logger");
      const { body: errorBody, status, headers } = mapVerificationError(verification);

      // Log at appropriate severity depending on error category
      if (status === 409) {
        logger.warn("nonce conflict during payment verification for POST /api/classifieds", {
          category, headline, errorCode: verification.errorCode,
        });
      } else if (status === 503) {
        logger.error("relay error during payment verification for POST /api/classifieds", {
          category, headline,
        });
      } else {
        logger.warn("payment verification failed for POST /api/classifieds", {
          category, headline, relayReason: verification.relayReason,
        });
      }

      // When retryable, return full payment requirements so the agent can re-pay
      if (status === 402 && verification.retryable !== false) {
        return buildPaymentRequired({
          amount: CLASSIFIED_PRICE_SATS,
          description: `${errorBody.error} Please pay ${CLASSIFIED_PRICE_SATS} sats sBTC to place a classified ad.`,
          code: errorBody.code,
        });
      }

      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          c.header(key, value);
        }
      }
      return c.json(errorBody, status);
    }

    // Derive btc_address: prefer body-provided address (validated), fall back to x402 payer identity.
    // The x402 payer is a Stacks address (SP...), not a bech32 BTC address, so we only
    // validate body-provided values against the bc1 format.
    const bodyAddress = (body.btc_address as string | undefined)
      ?? (body.contact as string | undefined);

    if (bodyAddress && !validateBtcAddress(bodyAddress)) {
      return c.json(
        { error: "Invalid BTC address format (expected bech32 bc1...)" },
        400
      );
    }

    const btc_address = bodyAddress ?? verification.payer;

    if (!btc_address) {
      return c.json(
        { error: "Could not determine address from payment. Provide btc_address or contact in body." },
        400
      );
    }

    const logger = c.get("logger");
    logger.info("payment verified for POST /api/classifieds", {
      btc_address,
      txid: verification.txid,
      paymentStatus: verification.paymentStatus,
      paymentId: verification.paymentId,
    });

    const result = await createClassified(c.env, {
      btc_address,
      category,
      headline: sanitizeString(headline, 100),
      body: adBody ? sanitizeString(adBody, 500) : null,
      payment_txid: verification.txid ?? null,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    logger.info("classified created (pending review)", {
      id: (result.data as { id?: string })?.id,
      btc_address,
      category,
    });

    // If the payment is still pending on-chain, include paymentId in the response so the
    // agent can verify settlement via /api/payment-status/:paymentId later.
    const pendingPayment =
      verification.paymentStatus === "pending" && verification.paymentId
        ? { paymentStatus: verification.paymentStatus, paymentId: verification.paymentId }
        : {};

    return c.json({ ...result.data, ...pendingPayment, message: "Classified submitted for editorial review" }, 201);
  }
);

export { classifiedsRouter };
