/**
 * Payment status route — allows agents to confirm x402 payment settlement
 * after receiving a pending response from brief or classifieds endpoints.
 */

import { Hono } from "hono";
import type { Env, AppVariables, CheckPaymentResult } from "../lib/types";
import { isRelayRPC } from "../services/x402";

const paymentStatusRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/payment-status/:paymentId — check settlement status of an x402 payment
paymentStatusRouter.get("/api/payment-status/:paymentId", async (c) => {
  const paymentId = c.req.param("paymentId");

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
  try {
    result = await c.env.X402_RELAY.checkPayment(paymentId);
  } catch (err) {
    console.error("[payment-status] checkPayment threw:", err);
    return c.json(
      { error: "Failed to reach payment relay — please retry shortly" },
      503
    );
  }

  if (result.status === "not_found") {
    return c.json(
      { error: "Payment not found — it may have expired or the id is incorrect", paymentId },
      404
    );
  }

  const body: Record<string, unknown> = {
    paymentId: result.paymentId,
    status: result.status,
  };

  if (result.txid !== undefined) {
    body.txid = result.txid;
  }
  if (result.explorerUrl !== undefined) {
    body.explorerUrl = result.explorerUrl;
  }
  if (result.error !== undefined) {
    body.error = result.error;
  }
  if (result.errorCode !== undefined) {
    body.error_code = result.errorCode;
  }
  if (result.retryable !== undefined) {
    body.retryable = result.retryable;
  }

  return c.json(body);
});

export { paymentStatusRouter };
