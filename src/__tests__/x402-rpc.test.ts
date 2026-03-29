import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyPayment } from "../services/x402";
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
  submitPayment: (txHex: string, settle?: unknown) => Promise<SubmitPaymentResult>,
  checkPayment: (paymentId: string) => Promise<CheckPaymentResult>
): Env {
  return {
    X402_RELAY: { submitPayment, checkPayment },
    // Stubs for required Env fields that are not exercised by verifyPayment
    NEWS_KV: {} as unknown as KVNamespace,
    NEWS_DO: {} as unknown as DurableObjectNamespace,
  };
}

afterEach(() => {
  vi.useRealTimers();
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
    });

    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>().mockResolvedValue({
      paymentId: "pay_001",
      status: "confirmed",
      txid: "tx_abc123",
    });

    const env = makeEnv(submitPayment, checkPayment);

    // Run verifyPayment, advancing fake timers as needed for any setTimeout delays
    const resultPromise = verifyPayment(makePaymentHeader(), 100, env);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.valid).toBe(true);
    expect(result.txid).toBe("tx_abc123");
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
      txid: "tx_gap_confirmed",
    });

    const env = makeEnv(submitPayment, checkPayment);

    const resultPromise = verifyPayment(makePaymentHeader(), 100, env);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    // Payment proceeds despite the gap warning
    expect(result.valid).toBe(true);
    expect(result.txid).toBe("tx_gap_confirmed");
    expect(submitPayment).toHaveBeenCalledOnce();
    expect(checkPayment).toHaveBeenCalledWith("pay_gap");
  });
});

// =============================================================================
// Polling timeout
// =============================================================================

describe("verifyPayment — RPC path — polling timeout", () => {
  it("returns valid:true with paymentStatus pending when poll exhausts with known pending status", async () => {
    vi.useFakeTimers();

    const submitPayment = vi.fn<Parameters<typeof makeEnv>[0]>().mockResolvedValue({
      accepted: true,
      paymentId: "pay_002",
      status: "queued",
    });

    // Always return "queued" — never confirms
    const checkPayment = vi.fn<Parameters<typeof makeEnv>[1]>().mockResolvedValue({
      paymentId: "pay_002",
      status: "queued",
    });

    const env = makeEnv(submitPayment, checkPayment);

    const resultPromise = verifyPayment(makePaymentHeader(), 100, env);
    // Advance all timers to exhaust the poll loop
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.valid).toBe(true);
    expect(result.paymentStatus).toBe("pending");
    expect(result.paymentId).toBe("pay_002");
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
    expect(result.relayReason).toMatch(/unexpected status/i);
    expect(checkPayment).toHaveBeenCalledTimes(2);
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
  });
});
