import type { Logger, PaymentTerminalReason } from "./types";
import { VERSION } from "../version";

export type PaymentLogEvent =
  | "payment.required"
  | "payment.accepted"
  | "payment.poll"
  | "payment.delivery_staged"
  | "payment.delivery_confirmed"
  | "payment.delivery_discarded"
  | "payment.reconciliation_pending"
  | "payment.retry_decision"
  | "payment.fallback_used";

export interface PaymentLogContext {
  route: string;
  paymentId?: string | null;
  status?: string | null;
  terminalReason?: PaymentTerminalReason | null;
  action?: string | null;
  checkStatusUrl_present?: boolean | null;
  compat_shim_used?: boolean | null;
}

export function buildPaymentLogContext(context: PaymentLogContext): Record<string, unknown> {
  return {
    service: "agent-news",
    route: context.route,
    paymentId: context.paymentId ?? null,
    status: context.status ?? null,
    terminalReason: context.terminalReason ?? null,
    action: context.action ?? null,
    checkStatusUrl_present: context.checkStatusUrl_present ?? false,
    compat_shim_used: context.compat_shim_used ?? false,
    repo_version: VERSION,
  };
}

export function logPaymentEvent(
  logger: Logger,
  level: "info" | "warn" | "error" | "debug",
  event: PaymentLogEvent,
  context: PaymentLogContext
): void {
  logger[level](event, buildPaymentLogContext(context));
}
