import { describe, expect, it, vi } from "vitest";
import { buildPaymentLogContext, logPaymentEvent } from "../lib/payment-logging";
import type { Logger } from "../lib/types";
import { VERSION } from "../version";

function makeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return logger as Logger & typeof logger;
}

describe("payment logging", () => {
  it("builds rollout log fields with stable defaults", () => {
    expect(buildPaymentLogContext({
      route: "/api/classifieds",
      paymentId: "pay_123",
      status: "queued",
      action: "payment_verified",
    })).toEqual({
      service: "agent-news",
      route: "/api/classifieds",
      paymentId: "pay_123",
      status: "queued",
      terminalReason: null,
      action: "payment_verified",
      checkStatusUrl_present: false,
      compat_shim_used: false,
      repo_version: VERSION,
    });
  });

  it("makes the legacy pending-header shim measurable in structured logs", () => {
    const logger = makeLogger();

    logPaymentEvent(logger, "info", "payment.delivery_staged", {
      route: "/api/brief/:date",
      paymentId: "pay_shim",
      status: "mempool",
      action: "return_202_pending_with_legacy_headers",
      checkStatusUrl_present: true,
      compat_shim_used: true,
    });

    expect(logger.info).toHaveBeenCalledWith(
      "payment.delivery_staged",
      expect.objectContaining({
        service: "agent-news",
        route: "/api/brief/:date",
        paymentId: "pay_shim",
        status: "mempool",
        action: "return_202_pending_with_legacy_headers",
        checkStatusUrl_present: true,
        compat_shim_used: true,
        repo_version: VERSION,
      })
    );
  });
});
