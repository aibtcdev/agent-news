/**
 * Wallet-driven classifieds endpoint.
 *
 * Independent of the x402 relay flow at /api/classifieds. The browser uses
 * @stacks/connect to sign an sBTC transfer to the treasury, broadcasts it,
 * and once the txid confirms, POSTs here with the txid + ad fields. The
 * server independently verifies the txid against the Hiro Stacks API before
 * inserting the row. Replay protection lives at the DB layer (partial UNIQUE
 * index on classifieds.payment_txid).
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
  createClassified,
  getClassifiedByTxid,
} from "../lib/do-client";
import { verifySbtcTransferTxid } from "../services/stacks-tx-verify";
import { transformClassified } from "./classifieds";

const classifiedsWebRouter = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

const webRateLimit = createRateLimitMiddleware({
  key: "classifieds-web",
  ...CLASSIFIED_RATE_LIMIT,
});

const TXID_REGEX = /^(0x)?[0-9a-fA-F]{64}$/;

classifiedsWebRouter.post(
  "/api/classifieds/web",
  webRateLimit,
  async (c) => {
    const logger = c.get("logger");

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const txid = typeof body.txid === "string" ? body.txid.trim() : "";
    const headline = (body.headline ?? body.title) as string | undefined;
    const category = body.category as string | undefined;
    const adBody = (body.body as string | undefined) ?? null;
    const bodyAddress = (body.btc_address as string | undefined)
      ?? (body.contact as string | undefined);

    if (!txid || !TXID_REGEX.test(txid)) {
      return c.json({ error: "Missing or malformed txid (expected 32-byte hex)." }, 400);
    }

    if (!category || !headline) {
      return c.json(
        { error: "Missing required fields: category, title (or headline)" },
        400
      );
    }

    if (!isClassifiedCategory(category)) {
      return c.json(
        { error: `Invalid category. Must be one of: ${CLASSIFIED_CATEGORIES.join(", ")}` },
        400
      );
    }

    if (bodyAddress && !validateBtcAddress(bodyAddress)) {
      return c.json(
        { error: "Invalid BTC address format (expected bech32 bc1...)" },
        400
      );
    }

    // Idempotency short-circuit: if this txid already produced a listing,
    // return it instead of re-running verification. Handles client retries
    // without surfacing the UNIQUE constraint conflict to the user.
    const existing = await getClassifiedByTxid(c.env, txid);
    if (existing) {
      logger.info("classifieds-web: returning existing row for txid", {
        txid,
        classifiedId: existing.id,
      });
      return c.json(
        { ...transformClassified(existing), message: "Classified already submitted for editorial review." },
        200
      );
    }

    const verification = await verifySbtcTransferTxid(txid, CLASSIFIED_PRICE_SATS, { logger });

    if (!verification.ok) {
      logger.warn("classifieds-web: tx verification failed", {
        txid,
        code: verification.code,
        reason: verification.reason,
      });

      switch (verification.code) {
        case "TX_PENDING":
          c.header("Retry-After", "10");
          return c.json(
            { error: verification.reason, code: verification.code, retryable: true },
            202
          );
        case "TX_NOT_FOUND":
          c.header("Retry-After", "15");
          return c.json(
            { error: verification.reason, code: verification.code, retryable: true },
            404
          );
        case "HIRO_UNAVAILABLE":
          c.header("Retry-After", "10");
          return c.json(
            { error: verification.reason, code: verification.code, retryable: true },
            503
          );
        case "TX_ABORTED":
        case "WRONG_CONTRACT":
        case "WRONG_FUNCTION":
        case "WRONG_RECIPIENT":
        case "WRONG_ASSET":
        case "INSUFFICIENT_AMOUNT":
        case "MALFORMED_TX":
          return c.json(
            { error: verification.reason, code: verification.code, retryable: false },
            400
          );
      }
    }

    const btc_address = bodyAddress ?? verification.sender;

    const createResult = await createClassified(c.env, {
      btc_address,
      category,
      headline: sanitizeString(headline, 100),
      body: adBody ? sanitizeString(adBody, 500) : null,
      payment_txid: verification.txid,
    });

    if (!createResult.ok || !createResult.data) {
      // Race: another POST for the same txid raced past the idempotency check
      // and won the UNIQUE-index battle. Return the row that did win.
      const recovered = await getClassifiedByTxid(c.env, verification.txid);
      if (recovered) {
        logger.info("classifieds-web: recovered after race on payment_txid", {
          txid: verification.txid,
          classifiedId: recovered.id,
        });
        return c.json(
          { ...transformClassified(recovered), message: "Classified already submitted for editorial review." },
          200
        );
      }

      logger.error("classifieds-web: createClassified failed", {
        txid: verification.txid,
        error: createResult.error,
      });
      return c.json(
        { error: createResult.error ?? "Failed to record classified submission" },
        createResult.status ?? 500
      );
    }

    logger.info("classifieds-web: classified created", {
      txid: verification.txid,
      sender: verification.sender,
      amount: verification.amount,
      classifiedId: createResult.data.id,
    });

    return c.json(
      {
        ...transformClassified(createResult.data),
        message: "Classified submitted for editorial review. An editor will review and publish your listing.",
      },
      201
    );
  }
);

export { classifiedsWebRouter };
