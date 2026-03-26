import { describe, it, expect } from "vitest";
import { mapVerificationError } from "../services/x402";
import type { PaymentVerifyResult } from "../services/x402";

describe("mapVerificationError", () => {
  // =========================================================================
  // 409 — nonce conflicts
  // =========================================================================

  describe("nonce conflicts → 409", () => {
    it("returns 409 with sender hint for SENDER_NONCE_STALE", () => {
      const result = mapVerificationError({
        valid: false,
        errorCode: "SENDER_NONCE_STALE",
      });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("SENDER_NONCE_STALE");
      expect(result.body.error).toContain("(sender)");
      expect(result.body.retryable).toBe(true);
      expect(result.body.hint).toContain("sender nonce");
      expect(result.headers?.["Retry-After"]).toBe("5");
    });

    it("returns 409 with sender hint for SENDER_NONCE_DUPLICATE", () => {
      const result = mapVerificationError({
        valid: false,
        errorCode: "SENDER_NONCE_DUPLICATE",
      });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("SENDER_NONCE_DUPLICATE");
      expect(result.body.error).toContain("(sender)");
      expect(result.headers?.["Retry-After"]).toBe("5");
    });

    it("returns 409 with longer Retry-After for SENDER_NONCE_GAP", () => {
      const result = mapVerificationError({
        valid: false,
        errorCode: "SENDER_NONCE_GAP",
      });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("SENDER_NONCE_GAP");
      expect(result.body.error).toContain("(sender)");
      expect(result.headers?.["Retry-After"]).toBe("30");
    });

    it("returns 409 with sponsor hint for SPONSOR_NONCE_STALE", () => {
      const result = mapVerificationError({
        valid: false,
        errorCode: "SPONSOR_NONCE_STALE",
      });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("SPONSOR_NONCE_STALE");
      expect(result.body.error).toContain("(sponsor)");
      expect(result.body.hint).toContain("recover-nonce");
      expect(result.headers?.["Retry-After"]).toBe("5");
    });

    it("returns 409 with sponsor hint for NONCE_CONFLICT", () => {
      const result = mapVerificationError({
        valid: false,
        errorCode: "NONCE_CONFLICT",
      });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("NONCE_CONFLICT");
      expect(result.body.error).toContain("(sponsor)");
      expect(result.headers?.["Retry-After"]).toBe("5");
    });
  });

  // =========================================================================
  // 503 — relay errors
  // =========================================================================

  describe("relay errors → 503", () => {
    it("returns 503 with RELAY_UNAVAILABLE code and Retry-After", () => {
      const result = mapVerificationError({
        valid: false,
        relayError: true,
      });

      expect(result.status).toBe(503);
      expect(result.body.code).toBe("RELAY_UNAVAILABLE");
      expect(result.body.retryable).toBe(true);
      expect(result.headers?.["Retry-After"]).toBe("10");
    });
  });

  // =========================================================================
  // 402 — payment invalid
  // =========================================================================

  describe("payment invalid → 402", () => {
    it("returns 402 with relay reason when present", () => {
      const result = mapVerificationError({
        valid: false,
        relayReason: "Signature mismatch",
      });

      expect(result.status).toBe(402);
      expect(result.body.error).toContain("Signature mismatch");
      expect(result.body.retryable).toBe(true);
      expect(result.headers).toBeUndefined();
    });

    it("returns 402 with code when errorCode is present", () => {
      const result = mapVerificationError({
        valid: false,
        errorCode: "AMOUNT_MISMATCH",
        relayReason: "Expected 30000, got 5000",
      });

      expect(result.status).toBe(402);
      expect(result.body.code).toBe("AMOUNT_MISMATCH");
      expect(result.body.error).toContain("Expected 30000");
    });

    it("returns 402 without code when no errorCode", () => {
      const result = mapVerificationError({
        valid: false,
      });

      expect(result.status).toBe(402);
      expect(result.body.code).toBeUndefined();
      expect(result.body.retryable).toBe(true);
    });

    it("respects retryable:false from verification", () => {
      const result = mapVerificationError({
        valid: false,
        retryable: false,
      });

      expect(result.status).toBe(402);
      expect(result.body.retryable).toBe(false);
    });
  });
});
