import { afterEach, describe, expect, it, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { X402_RELAY_URL } from "../lib/constants";

const originalFetch = globalThis.fetch;
const BTC_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const testEnv = env as typeof env & { BRIEFS_FREE?: string };

function makePaymentHeader(txHex = "deadbeefdeadbeef"): string {
  return btoa(JSON.stringify({ payload: { transaction: txHex }, x402Version: 2 }));
}

async function seedBrief(date: string, text: string): Promise<void> {
  const res = await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      briefs: [
        {
          date,
          text,
          json_data: JSON.stringify({ sections: [] }),
          compiled_at: "2026-04-02T12:00:00.000Z",
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
}

function mockRelayFallback(body: Record<string, unknown>, status = 200): void {
  globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof Request
        ? input.url
        : input.toString();
    if (url === `${X402_RELAY_URL}/settle`) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  testEnv.BRIEFS_FREE = "true";
});

describe("pending payment route guards", () => {
  it("does not deliver a brief when HTTP fallback returns pending without paymentId", async () => {
    testEnv.BRIEFS_FREE = "false";
    const date = "2026-04-21";
    await seedBrief(date, "classified brief content should stay locked");
    mockRelayFallback({
      success: false,
      status: "pending",
      payer: "SP2C2QH2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2",
    });

    const res = await SELF.fetch(`http://example.com/api/brief/${date}`, {
      headers: { "X-PAYMENT": makePaymentHeader("deadbeef0001") },
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("X-Payment-Status")).toBeNull();
    expect(res.headers.get("X-Payment-Id")).toBeNull();

    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("Payment relay unavailable");
  });

  it("does not finalize a classified when HTTP fallback returns pending without paymentId", async () => {
    const agentAddress = BTC_ADDRESS;
    mockRelayFallback({
      success: false,
      status: "pending",
      payer: "SP2C2QH2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2",
    });

    const res = await SELF.fetch("http://example.com/api/classifieds", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": makePaymentHeader("deadbeef0002"),
      },
      body: JSON.stringify({
        category: "services",
        title: "Pending without canonical tracking id",
        body: "Should not be created",
        btc_address: agentAddress,
      }),
    });

    expect(res.status).toBe(503);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("Payment relay unavailable");

    const listRes = await SELF.fetch(`http://example.com/api/classifieds?agent=${encodeURIComponent(agentAddress)}`);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json<{ total: number }>();
    expect(listBody.total).toBe(0);
  });

  it("keeps brief access staged behind 202 when paymentId is present", async () => {
    testEnv.BRIEFS_FREE = "false";
    const date = "2026-04-22";
    const paymentId = "pay_brief_stage_001";
    await seedBrief(date, "brief stays staged until confirmed");
    mockRelayFallback({
      success: false,
      status: "pending",
      paymentId,
      payer: "SP2C2QH2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2",
      checkStatusUrl: `https://relay.example.com/api/payment-status/${paymentId}`,
    });

    const res = await SELF.fetch(`http://example.com/api/brief/${date}`, {
      headers: { "X-PAYMENT": makePaymentHeader("deadbeef0003") },
    });

    expect(res.status).toBe(202);
    expect(res.headers.get("X-Payment-Status")).toBe("pending");
    expect(res.headers.get("X-Payment-Id")).toBe(paymentId);

    const body = await res.json<{ paymentId: string; paymentStatus: string }>();
    expect(body.paymentId).toBe(paymentId);
    expect(body.paymentStatus).toBe("pending");

    const stageRes = await SELF.fetch(`http://example.com/api/test/payment-stage/${paymentId}`);
    expect(stageRes.status).toBe(200);
    const stageBody = await stageRes.json<{ data: { stageStatus: string; payload: { kind: string; date: string } } }>();
    expect(stageBody.data.stageStatus).toBe("staged");
    expect(stageBody.data.payload.kind).toBe("brief_access");
    expect(stageBody.data.payload.date).toBe(date);
  });

  it("keeps classified submission staged behind 202 when paymentId is present", async () => {
    const paymentId = "pay_classified_stage_001";
    const agentAddress = BTC_ADDRESS;
    mockRelayFallback({
      success: false,
      status: "pending",
      paymentId,
      payer: "SP2C2QH2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2",
      checkStatusUrl: `https://relay.example.com/api/payment-status/${paymentId}`,
    });

    const res = await SELF.fetch("http://example.com/api/classifieds", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": makePaymentHeader("deadbeef0004"),
      },
      body: JSON.stringify({
        category: "services",
        title: "Staged classified keeps pending semantics",
        body: "Not durable until confirmed",
        btc_address: agentAddress,
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json<{ classifiedId: string; paymentId: string; paymentStatus: string }>();
    expect(body.paymentId).toBe(paymentId);
    expect(body.paymentStatus).toBe("pending");

    const stageRes = await SELF.fetch(`http://example.com/api/test/payment-stage/${paymentId}`);
    expect(stageRes.status).toBe(200);
    const stageBody = await stageRes.json<{ data: { stageStatus: string; payload: { kind: string; classified_id: string } } }>();
    expect(stageBody.data.stageStatus).toBe("staged");
    expect(stageBody.data.payload.kind).toBe("classified_submission");

    const classifiedRes = await SELF.fetch(`http://example.com/api/classifieds/${stageBody.data.payload.classified_id}`);
    expect(classifiedRes.status).toBe(404);
  });
});
