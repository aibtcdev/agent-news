import { describe, expect, it, vi } from "vitest";
import { verifySbtcTransferTxid } from "../services/stacks-tx-verify";
import {
  CLASSIFIED_PRICE_SATS,
  SBTC_CONTRACT_MAINNET,
  TREASURY_STX_ADDRESS,
} from "../lib/constants";

const SAMPLE_TXID = "0x" + "ab".repeat(32);
const SENDER = "SP2C2QH2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2H2";

function makeOkResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      tx_id: SAMPLE_TXID,
      tx_status: "success",
      tx_type: "contract_call",
      sender_address: SENDER,
      block_height: 123456,
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
            sender: SENDER,
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

function fetchReturning(response: Response): typeof fetch {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

describe("verifySbtcTransferTxid", () => {
  it("accepts a valid sBTC transfer to the treasury for the exact price", async () => {
    const result = await verifySbtcTransferTxid(SAMPLE_TXID, CLASSIFIED_PRICE_SATS, {
      fetchImpl: fetchReturning(makeOkResponse()),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sender).toBe(SENDER);
      expect(result.amount).toBe(CLASSIFIED_PRICE_SATS);
      expect(result.txid).toBe(SAMPLE_TXID);
      expect(result.blockHeight).toBe(123456);
    }
  });

  it("normalizes a txid without 0x prefix", async () => {
    const without0x = SAMPLE_TXID.slice(2);
    const result = await verifySbtcTransferTxid(without0x, CLASSIFIED_PRICE_SATS, {
      fetchImpl: fetchReturning(makeOkResponse()),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.txid).toBe(SAMPLE_TXID);
  });

  it("returns TX_NOT_FOUND on 404", async () => {
    const result = await verifySbtcTransferTxid(SAMPLE_TXID, CLASSIFIED_PRICE_SATS, {
      fetchImpl: fetchReturning(new Response("not found", { status: 404 })),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TX_NOT_FOUND");
  });

  it("returns TX_PENDING when tx_status is pending", async () => {
    const result = await verifySbtcTransferTxid(SAMPLE_TXID, CLASSIFIED_PRICE_SATS, {
      fetchImpl: fetchReturning(makeOkResponse({ tx_status: "pending" })),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TX_PENDING");
  });

  it("returns TX_ABORTED on abort_by_post_condition", async () => {
    const result = await verifySbtcTransferTxid(SAMPLE_TXID, CLASSIFIED_PRICE_SATS, {
      fetchImpl: fetchReturning(makeOkResponse({ tx_status: "abort_by_post_condition" })),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TX_ABORTED");
  });

  it("returns WRONG_CONTRACT when contract_id differs", async () => {
    const result = await verifySbtcTransferTxid(SAMPLE_TXID, CLASSIFIED_PRICE_SATS, {
      fetchImpl: fetchReturning(
        makeOkResponse({
          contract_call: { contract_id: "SP000.other-token", function_name: "transfer" },
          events: [], // contract mismatch caught before event matching anyway
        })
      ),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("WRONG_CONTRACT");
  });

  it("returns WRONG_FUNCTION when function_name is not transfer", async () => {
    const result = await verifySbtcTransferTxid(SAMPLE_TXID, CLASSIFIED_PRICE_SATS, {
      fetchImpl: fetchReturning(
        makeOkResponse({
          contract_call: { contract_id: SBTC_CONTRACT_MAINNET, function_name: "burn" },
        })
      ),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("WRONG_FUNCTION");
  });

  it("returns WRONG_RECIPIENT when no transfer event went to the treasury", async () => {
    const result = await verifySbtcTransferTxid(SAMPLE_TXID, CLASSIFIED_PRICE_SATS, {
      fetchImpl: fetchReturning(
        makeOkResponse({
          events: [
            {
              event_type: "fungible_token_asset",
              asset: {
                asset_event_type: "transfer",
                asset_id: `${SBTC_CONTRACT_MAINNET}::sbtc-token`,
                sender: SENDER,
                recipient: "SP000000000000000000002Q6VF78",
                amount: String(CLASSIFIED_PRICE_SATS),
              },
            },
          ],
        })
      ),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("WRONG_RECIPIENT");
  });

  it("returns INSUFFICIENT_AMOUNT when transferred sats are below the price", async () => {
    const result = await verifySbtcTransferTxid(SAMPLE_TXID, CLASSIFIED_PRICE_SATS, {
      fetchImpl: fetchReturning(
        makeOkResponse({
          events: [
            {
              event_type: "fungible_token_asset",
              asset: {
                asset_event_type: "transfer",
                asset_id: `${SBTC_CONTRACT_MAINNET}::sbtc-token`,
                sender: SENDER,
                recipient: TREASURY_STX_ADDRESS,
                amount: String(CLASSIFIED_PRICE_SATS - 1),
              },
            },
          ],
        })
      ),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INSUFFICIENT_AMOUNT");
  });

  it("returns HIRO_UNAVAILABLE on 503 from the API", async () => {
    const result = await verifySbtcTransferTxid(SAMPLE_TXID, CLASSIFIED_PRICE_SATS, {
      fetchImpl: fetchReturning(new Response("upstream error", { status: 503 })),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("HIRO_UNAVAILABLE");
  });

  it("returns HIRO_UNAVAILABLE when fetch throws", async () => {
    const result = await verifySbtcTransferTxid(SAMPLE_TXID, CLASSIFIED_PRICE_SATS, {
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("network gone")),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("HIRO_UNAVAILABLE");
  });

  it("accepts an overpayment", async () => {
    const result = await verifySbtcTransferTxid(SAMPLE_TXID, CLASSIFIED_PRICE_SATS, {
      fetchImpl: fetchReturning(
        makeOkResponse({
          events: [
            {
              event_type: "fungible_token_asset",
              asset: {
                asset_event_type: "transfer",
                asset_id: `${SBTC_CONTRACT_MAINNET}::sbtc-token`,
                sender: SENDER,
                recipient: TREASURY_STX_ADDRESS,
                amount: String(CLASSIFIED_PRICE_SATS * 2),
              },
            },
          ],
        })
      ),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.amount).toBe(CLASSIFIED_PRICE_SATS * 2);
  });
});
