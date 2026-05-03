/**
 * Integration tests for POST /api/classifieds/web — wallet-driven classifieds.
 *
 * Mocks globalThis.fetch so the Hiro Stacks API never gets a real call, but
 * the rest of the pipeline (route handler, DO insert, partial UNIQUE index,
 * idempotency check) runs end-to-end against the in-test Worker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import {
  CLASSIFIED_PRICE_SATS,
  SBTC_CONTRACT_MAINNET,
  TREASURY_STX_ADDRESS,
} from "../lib/constants";

const SAMPLE_TXID = "0x" + "ab".repeat(32);
const SENDER_STX = "SP2C2QH2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2";

const originalFetch = globalThis.fetch;

function makeHiroSuccess(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      tx_id: SAMPLE_TXID,
      tx_status: "success",
      tx_type: "contract_call",
      sender_address: SENDER_STX,
      block_height: 200000,
      contract_call: {
        contract_id: SBTC_CONTRACT_MAINNET,
        function_name: "transfer",
      },
      events: [
        {
          event_type: "fungible_token_asset",
          asset: {
            asset_event_type: "transfer",
            asset_id: `${SBTC_CONTRACT_MAINNET}::sbtc-token`,
            sender: SENDER_STX,
            recipient: TREASURY_STX_ADDRESS,
            amount: String(CLASSIFIED_PRICE_SATS),
          },
        },
      ],
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/** Replace globalThis.fetch but keep Worker-internal fetches working. */
function mockHiroFetch(impl: (txid: string) => Response | Promise<Response>) {
  globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://api.hiro.so/")) {
      const txid = decodeURIComponent(url.split("/").pop() ?? "");
      return impl(txid);
    }
    return originalFetch(input as RequestInfo, init);
  });
}

beforeEach(() => {
  // Each test installs its own Hiro stub; default to original fetch otherwise.
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

async function postWeb(body: Record<string, unknown>) {
  return SELF.fetch("http://example.com/api/classifieds/web", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/classifieds/web — happy path", () => {
  it("creates a pending_review classified after a verified sBTC transfer", async () => {
    mockHiroFetch(() => makeHiroSuccess());

    const res = await postWeb({
      txid: SAMPLE_TXID,
      title: "Wallet flow ad",
      category: "services",
      body: "Posted from a real Stacks wallet.",
    });

    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.title).toBe("Wallet flow ad");
    expect(body.category).toBe("services");
    expect(body.status).toBe("pending_review");
    expect(body.placedBy).toBe(SENDER_STX);
    expect(body.paymentTxid).toBe(SAMPLE_TXID);
    expect(body.message).toContain("editorial review");
  });

  it("uses caller-supplied btc_address when provided", async () => {
    mockHiroFetch(() => makeHiroSuccess());
    const customAddr = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    const res = await postWeb({
      txid: "0x" + "cd".repeat(32),
      title: "Override addr",
      category: "wanted",
      btc_address: customAddr,
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.placedBy).toBe(customAddr);
  });
});

describe("POST /api/classifieds/web — idempotency", () => {
  it("returns the existing row instead of inserting twice for the same txid", async () => {
    const reusedTxid = "0x" + "ee".repeat(32);
    mockHiroFetch(() => makeHiroSuccess({ tx_id: reusedTxid }));

    const first = await postWeb({
      txid: reusedTxid,
      title: "Replay test",
      category: "agents",
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json<Record<string, unknown>>();

    const second = await postWeb({
      txid: reusedTxid,
      title: "Replay test (different title — should be ignored)",
      category: "agents",
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json<Record<string, unknown>>();
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.title).toBe("Replay test"); // original wins
    expect(secondBody.message).toContain("already submitted");
  });
});

describe("POST /api/classifieds/web — verification failures", () => {
  it("returns 202 with Retry-After when the tx is still pending", async () => {
    mockHiroFetch(() => makeHiroSuccess({ tx_status: "pending" }));
    const res = await postWeb({
      txid: "0x" + "11".repeat(32),
      title: "Pending",
      category: "services",
    });
    expect(res.status).toBe(202);
    expect(res.headers.get("Retry-After")).toBe("10");
    const body = await res.json<{ code: string; retryable: boolean }>();
    expect(body.code).toBe("TX_PENDING");
    expect(body.retryable).toBe(true);
  });

  it("returns 404 when the tx is not yet visible to Hiro", async () => {
    mockHiroFetch(() => new Response("not found", { status: 404 }));
    const res = await postWeb({
      txid: "0x" + "22".repeat(32),
      title: "Not found",
      category: "services",
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("TX_NOT_FOUND");
  });

  it("returns 400 when the tx aborted on-chain", async () => {
    mockHiroFetch(() => makeHiroSuccess({ tx_status: "abort_by_post_condition" }));
    const res = await postWeb({
      txid: "0x" + "33".repeat(32),
      title: "Aborted",
      category: "services",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ code: string; retryable: boolean }>();
    expect(body.code).toBe("TX_ABORTED");
    expect(body.retryable).toBe(false);
  });

  it("returns 400 for wrong recipient", async () => {
    mockHiroFetch(() =>
      makeHiroSuccess({
        events: [
          {
            event_type: "fungible_token_asset",
            asset: {
              asset_event_type: "transfer",
              asset_id: `${SBTC_CONTRACT_MAINNET}::sbtc-token`,
              sender: SENDER_STX,
              recipient: "SP000000000000000000002Q6VF78",
              amount: String(CLASSIFIED_PRICE_SATS),
            },
          },
        ],
      })
    );
    const res = await postWeb({
      txid: "0x" + "44".repeat(32),
      title: "Wrong recipient",
      category: "services",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("WRONG_RECIPIENT");
  });

  it("returns 400 for insufficient amount", async () => {
    mockHiroFetch(() =>
      makeHiroSuccess({
        events: [
          {
            event_type: "fungible_token_asset",
            asset: {
              asset_event_type: "transfer",
              asset_id: `${SBTC_CONTRACT_MAINNET}::sbtc-token`,
              sender: SENDER_STX,
              recipient: TREASURY_STX_ADDRESS,
              amount: String(CLASSIFIED_PRICE_SATS - 1),
            },
          },
        ],
      })
    );
    const res = await postWeb({
      txid: "0x" + "55".repeat(32),
      title: "Underpaid",
      category: "services",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("INSUFFICIENT_AMOUNT");
  });

  it("returns 503 when Hiro is unavailable", async () => {
    mockHiroFetch(() => new Response("upstream", { status: 503 }));
    const res = await postWeb({
      txid: "0x" + "66".repeat(32),
      title: "Hiro down",
      category: "services",
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("10");
    const body = await res.json<{ code: string; retryable: boolean }>();
    expect(body.code).toBe("HIRO_UNAVAILABLE");
    expect(body.retryable).toBe(true);
  });
});

describe("POST /api/classifieds/web — input validation", () => {
  it("returns 400 for missing txid", async () => {
    const res = await postWeb({ title: "x", category: "services" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed txid", async () => {
    const res = await postWeb({ txid: "not-a-hex", title: "x", category: "services" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing title and headline", async () => {
    const res = await postWeb({ txid: SAMPLE_TXID, category: "services" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid category", async () => {
    const res = await postWeb({
      txid: SAMPLE_TXID,
      title: "x",
      category: "not-a-category",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed btc_address override", async () => {
    const res = await postWeb({
      txid: SAMPLE_TXID,
      title: "x",
      category: "services",
      btc_address: "not-a-bech32",
    });
    expect(res.status).toBe(400);
  });
});
