/**
 * Payment status route — allows agents to confirm x402 payment settlement
 * after receiving a pending response from brief or classifieds endpoints.
 */

import { Hono } from "hono";
import type { Env, AppVariables, CheckPaymentResult } from "../lib/types";
import { reconcilePaymentStage } from "../lib/do-client";
import { logPaymentEvent } from "../lib/payment-logging";
import { buildPaymentStatusResponse, isRelayRPC } from "../services/x402";

const paymentStatusRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/payment-status/:paymentId — check settlement status of an x402 payment
paymentStatusRouter.get("/api/payment-status/:paymentId", async (c) => {
  const paymentId = c.req.param("paymentId");
  const logger = c.get("logger");

  if (!paymentId || !paymentId.startsWith("pay_")) {
    return c.json(
      { error: "Invalid paymentId — expected a relay payment identifier (pay_ prefix)" },
      400
    );
  }

  if (!c.env.X402_RELAY || !isRelayRPC(c.env.X402_RELAY)) {
    return c.json(
      { error: "Payment relay unavailable — this endpoint requires the X402_RELAY service binding" },
      503
    );
  }

  let result: CheckPaymentResult;
  let body: ReturnType<typeof buildPaymentStatusResponse>;
  try {
    result = await c.env.X402_RELAY.checkPayment(paymentId);
    body = buildPaymentStatusResponse(result);
  } catch (err) {
    console.error("[payment-status] invalid checkPayment response:", err);
    return c.json(
      { error: "Failed to reach payment relay — please retry shortly" },
      503
    );
  }
  logPaymentEvent(logger, "info", "payment.poll", {
    route: "/api/payment-status/:paymentId",
    paymentId,
    status: body.status,
    terminalReason: body.terminalReason ?? null,
    action: "check_payment_status",
    checkStatusUrl_present: Boolean(body.checkStatusUrl),
  });

  if (body.status === "confirmed" || body.status === "failed" || body.status === "replaced" || body.status === "not_found") {
    const reconcileResult = await reconcilePaymentStage(c.env, paymentId, {
      status: body.status,
      txid: body.txid,
      terminalReason: body.terminalReason,
    });
    const stage = reconcileResult.data;
    if (stage?.stageStatus === "finalized") {
      logPaymentEvent(logger, "info", "payment.delivery_confirmed", {
        route: "/api/payment-status/:paymentId",
        paymentId,
        status: body.status,
        action: "reconcile_confirmed_stage",
        checkStatusUrl_present: Boolean(body.checkStatusUrl),
      });
    } else if (stage?.stageStatus === "discarded") {
      logPaymentEvent(logger, "warn", "payment.delivery_discarded", {
        route: "/api/payment-status/:paymentId",
        paymentId,
        status: body.status,
        terminalReason: body.terminalReason ?? null,
        action: "discard_provisional_delivery",
        checkStatusUrl_present: Boolean(body.checkStatusUrl),
      });
    }
  }

  if (body.status === "failed" || body.status === "replaced" || body.status === "not_found") {
    logPaymentEvent(logger, "warn", "payment.retry_decision", {
      route: "/api/payment-status/:paymentId",
      paymentId,
      status: body.status,
      terminalReason: body.terminalReason ?? null,
      action: body.status === "replaced" || body.status === "not_found"
        ? "stop_poll_old_payment"
        : body.retryable
          ? "retry_payment"
          : "stop_retry",
      checkStatusUrl_present: Boolean(body.checkStatusUrl),
    });
  }

  if (body.status === "not_found") {
    return c.json(
      { ...body, error: body.error ?? "Payment not found — it may have expired or the id is incorrect" },
      404
    );
  }

  return c.json(body);
});

export { paymentStatusRouter };
