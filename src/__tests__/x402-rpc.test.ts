import { describe, it, expect, vi, afterEach } from "vitest";
import { resetRelayCircuitBreakerForTests, verifyPayment } from "../services/x402";
import type { Env, SubmitPaymentResult, CheckPaymentResult } from "../lib/types";

/**
 * Unit tests for the verifyPayment() RPC relay path.
 *
 * These tests exercise verifyPayment() directly by providing a mock RelayRPC
 * binding via the Env argument. No Cloudflare worker runtime or Durable Object
 * is required.
 *
 * The x402 v2 payment payload shape used in all tests:
 *   { payload: { transaction: "<hex>" }, ... }
 * Base64-encoded as the paymentHeader argument.
 */

/** Build a valid base64-encoded x402 v2 payment header with a dummy transaction hex. */
function makePaymentHeader(txHex = "deadbeefdeadbeef"): string {
  const payload = { payload: { transaction: txHex }, x402Version: 2 };
  return btoa(JSON.stringify(payload));
}

/** Build a minimal Env mock with a mocked X402_RELAY binding. */
function makeEnv(
  submitPayment: (txHex: string, settle?: unknown, paymentIdentifier?: string) => Promise<SubmitPaymentResult>,
  checkPayment: (paymentId: string) => Promise<CheckPaymentResult>
): Env {
  return {
    X402_RELAY: { submitPayment, checkPayment },
    // Stubs for required Env fields that are not exercised by verifyPayment
    NEWS_KV: {} as unknown as KVNamespace,
    NEWS_DO: {} as unknown as DurableObjectNamespace,
    ASSETS: {} as unknown as Fetcher,
  };
}

afterEach(() => {
  vi.useRealTimers();
  resetRelayCircuitBreakerForTests();
});

// =============================================================================
// Happy path
// =============================================================================

describe("verifyPayment — RPC path — happy path", () => {
  it("returns valid:true with txid when payment is accepted then confirmed", async () => {
    vi.useFakeTimers();

    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockResolvedValue({
      accepted: true,
      paymentId: "pay_001",
      status: "queued",
      checkStatusUrl: "https://relay.example.com/api/payment-status/pay_001",
    });

    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>().mockResolvedValue({
      paymentId: "pay_001",
      status: "confirmed",
      txid: "a".repeat(64),
      checkStatusUrl: "https://relay.example.com/api/payment-status/pay_001",
    });

    const env = makeEnv(submitPayment, checkPayment);

    // Run verifyPayment, advancing fake timers as needed for any setTimeout delays
    const resultPromise = verifyPayment(makePaymentHeader(), 100, env);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.valid).toBe(true);
    expect(result.txid).toBe("a".repeat(64));
    expect(result.paymentState).toBe("confirmed");
    expect(result.checkStatusUrl).toBe("https://relay.example.com/api/payment-status/pay_001");
    expect(submitPayment).toHaveBeenCalledOnce();
    expect(checkPayment).toHaveBeenCalledWith("pay_001");
  });
});

// =============================================================================
// Nonce errors
// =============================================================================

describe("verifyPayment — RPC path — nonce errors", () => {
  it("returns errorCode and retryable:true when submitPayment rejects with SENDER_NONCE_STALE", async () => {
    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockResolvedValue({
      accepted: false,
      code: "SENDER_NONCE_STALE",
      error: "Stale nonce — expected 5 but received 3",
      retryable: true,
    });

    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>();

    const env = makeEnv(submitPayment, checkPayment);
    const result = await verifyPayment(makePaymentHeader(), 100, env);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("SENDER_NONCE_STALE");
    expect(result.terminalReason).toBe("sender_nonce_stale");
    expect(result.retryable).toBe(true);
    // Relay error flag should NOT be set — this is a payment-level rejection, not a relay fault
    expect(result.relayError).toBeUndefined();
    expect(checkPayment).not.toHaveBeenCalled();
  });

  it("returns errorCode when submitPayment rejects with SENDER_NONCE_DUPLICATE", async () => {
    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockResolvedValue({
      accepted: false,
      code: "SENDER_NONCE_DUPLICATE",
      error: "Duplicate nonce — already seen",
      retryable: true,
    });

    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>();

    const env = makeEnv(submitPayment, checkPayment);
    const result = await verifyPayment(makePaymentHeader(), 100, env);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("SENDER_NONCE_DUPLICATE");
    expect(result.terminalReason).toBe("sender_nonce_duplicate");
    expect(result.retryable).toBe(true);
  });
});

// =============================================================================
// Nonce gap warning (accepted with warning)
// =============================================================================

describe("verifyPayment — RPC path — nonce gap warning", () => {
  it("returns valid:true when submitPayment accepts with a nonce gap warning", async () => {
    vi.useFakeTimers();

    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockResolvedValue({
      accepted: true,
      paymentId: "pay_gap",
      status: "queued_with_warning",
      warning: {
        code: "SENDER_NONCE_GAP",
        detail: "Nonce gap: sent 7, expected 5",
        senderNonce: { provided: 7, expected: 5, lastSeen: 4 },
        help: "https://docs.example.com/nonce",
        action: "Payment queued but may sit in mempool until gap is filled",
      },
    });

    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>().mockResolvedValue({
      paymentId: "pay_gap",
      status: "confirmed",
      txid: "b".repeat(64),
    });

    const env = makeEnv(submitPayment, checkPayment);

    const resultPromise = verifyPayment(makePaymentHeader(), 100, env);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    // Payment proceeds despite the gap warning
    expect(result.valid).toBe(true);
    expect(result.txid).toBe("b".repeat(64));
    expect(submitPayment).toHaveBeenCalledOnce();
    expect(checkPayment).toHaveBeenCalledWith("pay_gap");
  });
});

// =============================================================================
// Polling timeout
// =============================================================================

describe("verifyPayment — RPC path — polling timeout", () => {
  it("keeps mempool pending instead of treating it as success", async () => {
    vi.useFakeTimers();

    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockResolvedValue({
      accepted: true,
      paymentId: "pay_mempool",
      status: "queued",
    });

    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>().mockResolvedValue({
      paymentId: "pay_mempool",
      status: "mempool",
      txid: "c".repeat(64),
    });

    const env = makeEnv(submitPayment, checkPayment);
    const resultPromise = verifyPayment(makePaymentHeader(), 100, env);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.valid).toBe(true);
    expect(result.paymentStatus).toBe("pending");
    expect(result.paymentState).toBe("mempool");
    expect(result.txid).toBeUndefined();
  });

  it("returns valid:true with paymentStatus pending when poll exhausts with known pending status", async () => {
    vi.useFakeTimers();

    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockResolvedValue({
      accepted: true,
      paymentId: "pay_002",
      status: "queued",
      checkStatusUrl: "https://relay.example.com/api/payment-status/pay_002",
    });

    // Always return "queued" — never confirms
    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>().mockResolvedValue({
      paymentId: "pay_002",
      status: "queued",
      checkStatusUrl: "https://relay.example.com/api/payment-status/pay_002",
    });

    const env = makeEnv(submitPayment, checkPayment);

    const resultPromise = verifyPayment(makePaymentHeader(), 100, env);
    // Advance all timers to exhaust the poll loop
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.valid).toBe(true);
    expect(result.paymentStatus).toBe("pending");
    expect(result.paymentId).toBe("pay_002");
    expect(result.paymentState).toBe("queued");
    expect(result.checkStatusUrl).toBe("https://relay.example.com/api/payment-status/pay_002");
    // checkPayment should have been called RPC_POLL_MAX_ATTEMPTS (2) times
    expect(checkPayment).toHaveBeenCalledTimes(2);
  });

  it("returns relayError:true when poll exhausts with unexpected status (safety net)", async () => {
    vi.useFakeTimers();

    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockResolvedValue({
      accepted: true,
      paymentId: "pay_unexpected",
      status: "queued",
    });

    // Return an unknown future status the code does not handle
    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>().mockResolvedValue({
      paymentId: "pay_unexpected",
      status: "some_future_unknown_status" as CheckPaymentResult["status"],
    });

    const env = makeEnv(submitPayment, checkPayment);

    const resultPromise = verifyPayment(makePaymentHeader(), 100, env);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.valid).toBe(false);
    expect(result.relayError).toBe(true);
    expect(result.relayReason).toMatch(/invalid payment status payload/i);
    expect(checkPayment).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Immediate rejection
// =============================================================================

describe("verifyPayment — RPC path — immediate rejection", () => {
  it("returns errorCode and retryable:false when submitPayment rejects as NOT_SPONSORED", async () => {
    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockResolvedValue({
      accepted: false,
      code: "NOT_SPONSORED",
      error: "Transaction not eligible for sponsorship",
      retryable: false,
    });

    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>();

    const env = makeEnv(submitPayment, checkPayment);
    const result = await verifyPayment(makePaymentHeader(), 100, env);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("NOT_SPONSORED");
    expect(result.terminalReason).toBe("not_sponsored");
    expect(result.retryable).toBe(false);
    expect(result.relayError).toBeUndefined();
    expect(checkPayment).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Relay error — submitPayment throws
// =============================================================================

describe("verifyPayment — RPC path — relay errors", () => {
  it("returns relayError:true when submitPayment throws", async () => {
    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockRejectedValue(
      new Error("connection refused")
    );

    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>();

    const env = makeEnv(submitPayment, checkPayment);
    const result = await verifyPayment(makePaymentHeader(), 100, env);

    expect(result.valid).toBe(false);
    expect(result.relayError).toBe(true);
    expect(checkPayment).not.toHaveBeenCalled();
  });

  it("returns relayError:true when checkPayment throws", async () => {
    vi.useFakeTimers();

    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockResolvedValue({
      accepted: true,
      paymentId: "pay_003",
      status: "queued",
    });

    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>().mockRejectedValue(
      new Error("upstream timeout")
    );

    const env = makeEnv(submitPayment, checkPayment);

    const resultPromise = verifyPayment(makePaymentHeader(), 100, env);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.valid).toBe(false);
    expect(result.relayError).toBe(true);
    expect(result.relayReason).toContain("Failed to reach payment relay");
  });

  it("returns relayError:true when checkPayment returns an invalid internal-only status", async () => {
    vi.useFakeTimers();

    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockResolvedValue({
      accepted: true,
      paymentId: "pay_submitted_invalid",
      status: "queued",
    });

    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>().mockResolvedValue({
      paymentId: "pay_submitted_invalid",
      status: "submitted" as CheckPaymentResult["status"],
    });

    const env = makeEnv(submitPayment, checkPayment);

    const resultPromise = verifyPayment(makePaymentHeader(), 100, env);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.valid).toBe(false);
    expect(result.relayError).toBe(true);
    expect(result.relayReason).toContain("invalid payment status payload");
  });

  it("preserves relay-owned paymentId for duplicate in-flight flows", async () => {
    vi.useFakeTimers();

    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockResolvedValue({
      accepted: true,
      paymentId: "pay_duplicate",
      status: "queued",
    });

    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>().mockResolvedValue({
      paymentId: "pay_duplicate",
      status: "broadcasting",
    });

    const env = makeEnv(submitPayment, checkPayment);
    const [firstPromise, secondPromise] = [
      verifyPayment(makePaymentHeader("deadbeef01"), 100, env),
      verifyPayment(makePaymentHeader("deadbeef01"), 100, env),
    ];
    await vi.runAllTimersAsync();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.paymentId).toBe("pay_duplicate");
    expect(second.paymentId).toBe("pay_duplicate");
    expect(first.paymentStatus).toBe("pending");
    expect(second.paymentStatus).toBe("pending");
  });
});

// =============================================================================
// Payment identifier — V2 RPC idempotency
// =============================================================================

describe("verifyPayment — RPC path — payment identifier", () => {
  it("passes a pay_<hex> paymentIdentifier as third arg to submitPayment", async () => {
    vi.useFakeTimers();

    const txHex = "deadbeef0123456789abcdef";
    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockResolvedValue({
      accepted: true,
      paymentId: "pay_ident_001",
      status: "queued",
    });

    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>().mockResolvedValue({
      paymentId: "pay_ident_001",
      status: "confirmed",
      txid: "d".repeat(64),
    });

    const env = makeEnv(submitPayment, checkPayment);
    const resultPromise = verifyPayment(makePaymentHeader(txHex), 100, env);
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(submitPayment).toHaveBeenCalledOnce();
    const [calledTxHex, _settle, calledIdentifier] = submitPayment.mock.calls[0];
    expect(calledTxHex).toBe(txHex);
    // Identifier must match pay_<28-hex-chars> and be deterministic for this txHex
    expect(calledIdentifier).toMatch(/^pay_[a-f0-9]{28}$/);
  });

  it("derives the same identifier for the same txHex (deterministic across retries)", async () => {
    vi.useFakeTimers();

    const txHex = "cafebabe0000000011111111";
    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockResolvedValue({
      accepted: true,
      paymentId: "pay_retry_001",
      status: "queued",
    });

    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>().mockResolvedValue({
      paymentId: "pay_retry_001",
      status: "confirmed",
      txid: "e".repeat(64),
    });

    const env = makeEnv(submitPayment, checkPayment);

    const firstPromise = verifyPayment(makePaymentHeader(txHex), 100, env);
    await vi.runAllTimersAsync();
    await firstPromise;

    const secondPromise = verifyPayment(makePaymentHeader(txHex), 100, env);
    await vi.runAllTimersAsync();
    await secondPromise;

    const [, , firstIdentifier] = submitPayment.mock.calls[0];
    const [, , secondIdentifier] = submitPayment.mock.calls[1];
    // Both calls derive the same identifier from the same txHex
    expect(firstIdentifier).toBe(secondIdentifier);
    expect(firstIdentifier).toMatch(/^pay_[a-f0-9]{28}$/);
  });

  it("maps PAYMENT_IDENTIFIER_CONFLICT to 402 non-retryable", async () => {
    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockResolvedValue({
      accepted: false,
      code: "PAYMENT_IDENTIFIER_CONFLICT",
      error: "Same identifier submitted with a different transaction",
      retryable: false,
    });

    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>();

    const env = makeEnv(submitPayment, checkPayment);
    const result = await verifyPayment(makePaymentHeader(), 100, env);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("PAYMENT_IDENTIFIER_CONFLICT");
    expect(result.retryable).toBe(false);
    // Should NOT be treated as a relay error
    expect(result.relayError).toBeUndefined();
    expect(checkPayment).not.toHaveBeenCalled();
  });
});
