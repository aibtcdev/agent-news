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
  reconcilePaymentStage,
  stagePayment,
  getClassifiedsRotation,
} from "../lib/do-client";
import { logPaymentEvent } from "../lib/payment-logging";
import { buildLocalPaymentStatusUrl, buildPaymentRequired, verifyPayment, mapVerificationError } from "../services/x402";
import { resolveNamesWithTimeout, generateId } from "../lib/helpers";

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

  // Resolve agent display names
  const clAddresses = [...new Set(transformed.map((cl) => cl.placedBy).filter(Boolean))];
  const clNameMap = await resolveNamesWithTimeout(
    c.env.NEWS_KV,
    clAddresses,
    (p) => c.executionCtx.waitUntil(p)
  );
  const withNames = transformed.map((cl) => {
    const info = clNameMap.get(cl.placedBy);
    const avatarAddr = info?.btcAddress ?? cl.placedBy;
    return {
      ...cl,
      displayName: info?.name ?? null,
      avatar: `https://bitcoinfaces.xyz/api/get-image?name=${encodeURIComponent(avatarAddr)}`,
    };
  });

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({ classifieds: withNames, total: withNames.length });
});

// GET /api/classifieds/:id — get a single classified ad
classifiedsRouter.get("/api/classifieds/:id", async (c) => {
  const id = c.req.param("id");
  const cl = await getClassified(c.env, id);
  if (!cl) {
    return c.json({ error: `Classified "${id}" not found` }, 404);
  }
  const clData = transformClassified(cl);
  const singleNameMap = await resolveNamesWithTimeout(
    c.env.NEWS_KV,
    [clData.placedBy].filter(Boolean),
    (p) => c.executionCtx.waitUntil(p)
  );
  const clInfo = singleNameMap.get(clData.placedBy);
  const clAvatarAddr = clInfo?.btcAddress ?? clData.placedBy;
  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return c.json({
    ...clData,
    displayName: clInfo?.name ?? null,
    avatar: `https://bitcoinfaces.xyz/api/get-image?name=${encodeURIComponent(clAvatarAddr)}`,
  });
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
      logPaymentEvent(logger, "info", "payment.required", {
        route: "/api/classifieds",
        action: "return_402_payment_required",
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
    const verification = await verifyPayment(paymentHeader, CLASSIFIED_PRICE_SATS, c.env, {
      logger: c.get("logger"),
      route: "/api/classifieds",
    });
    if (!verification.valid) {
      const logger = c.get("logger");
      const { body: errorBody, status, headers } = mapVerificationError(verification);
      logPaymentEvent(logger, status === 503 ? "error" : "warn", "payment.retry_decision", {
        route: "/api/classifieds",
        paymentId: verification.paymentId,
        status: verification.paymentState ?? null,
        terminalReason: verification.terminalReason ?? null,
        action: status === 409
          ? "retry_after_nonce_recovery"
          : status === 503
            ? "retry_after_relay_recovery"
            : errorBody.retryable
              ? "repay_or_resubmit"
              : "stop_retry",
      });

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

    const provisionalClassifiedId = generateId();
    const logger = c.get("logger");
    logPaymentEvent(logger, "info", "payment.accepted", {
      route: "/api/classifieds",
      paymentId: verification.paymentId,
      status: verification.paymentState ?? "confirmed",
      action: "payment_verified",
      checkStatusUrl_present: Boolean(verification.checkStatusUrl),
    });
    logger.info("payment verified for POST /api/classifieds", {
      btc_address,
      txid: verification.txid,
      paymentStatus: verification.paymentStatus,
      paymentId: verification.paymentId,
      stagedClassifiedId: provisionalClassifiedId,
    });

    if (!verification.paymentId) {
      return c.json(
        { error: "Relay accepted payment but did not provide a paymentId for classified staging" },
        503
      );
    }

    const stageResult = await stagePayment(c.env, {
      paymentId: verification.paymentId,
      payload: {
        kind: "classified_submission",
        classified_id: provisionalClassifiedId,
        btc_address,
        category,
        headline: sanitizeString(headline, 100),
        body: adBody ? sanitizeString(adBody, 500) : null,
        payment_txid: verification.txid ?? null,
      },
    });
    if (!stageResult.ok || !stageResult.data) {
      return c.json({ error: stageResult.error ?? "Failed to stage classified submission" }, stageResult.status ?? 500);
    }
    logPaymentEvent(logger, "info", "payment.delivery_staged", {
      route: "/api/classifieds",
      paymentId: verification.paymentId,
      status: verification.paymentState ?? "queued",
      action: verification.paymentStatus === "pending"
        ? "return_202_pending"
        : "stage_classified_submission",
      checkStatusUrl_present: Boolean(verification.checkStatusUrl),
      compat_shim_used: false,
    });

    const stagedClassifiedId = stageResult.data.payload.kind === "classified_submission"
      ? stageResult.data.payload.classified_id
      : provisionalClassifiedId;

    if (verification.paymentState === "confirmed") {
      await reconcilePaymentStage(c.env, verification.paymentId, {
        status: "confirmed",
        txid: verification.txid,
      });

      const finalized = await getClassified(c.env, stagedClassifiedId);
      if (!finalized) {
        return c.json({ error: "Failed to finalize confirmed classified submission" }, 500);
      }

      logger.info("classified finalized after confirmed payment", {
        id: finalized.id,
        paymentId: verification.paymentId,
      });
      logPaymentEvent(logger, "info", "payment.delivery_confirmed", {
        route: "/api/classifieds",
        paymentId: verification.paymentId,
        status: "confirmed",
        action: "classified_submission_finalized",
      });
      return c.json({ ...transformClassified(finalized), paymentId: verification.paymentId, message: "Classified submitted for editorial review" }, 201);
    }

    const checkStatusUrl = verification.checkStatusUrl ?? buildLocalPaymentStatusUrl(new URL(c.req.url).origin, verification.paymentId);

    return c.json(
      {
        classifiedId: stagedClassifiedId,
        paymentId: verification.paymentId,
        paymentStatus: "pending",
        status: verification.paymentState ?? "queued",
        checkStatusUrl,
        message: "Classified submission is staged until the payment is confirmed.",
      },
      202
    );
  }
);

export { classifiedsRouter };
