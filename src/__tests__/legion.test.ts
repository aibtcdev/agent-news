import { describe, it, expect } from "vitest";
import {
  decodeClarityHex,
  toJSON,
  asNumber,
  unwrapOptional,
  tupleField,
  ClarityDecodeError,
} from "../lib/clarity";
import {
  encodeStringAscii,
  blocksRemaining,
  nextBoundaryHeight,
  predictOutcome,
} from "../services/legion-chain";
import { extractEvents } from "../routes/legion";
import { BRIEF_STATUS, LEGION_GOV_CONTRACT } from "../lib/legion-constants";

/**
 * Fixtures are real bytes captured from the deployed v2 contracts
 * (ST2BEBZJ8Y2H6F5DK9KC450238Y3HGJCS9B7P2JD3, block 4049396), not
 * hand-authored. If the codec drifts these stop matching the chain rather than
 * stopping matching an assumption.
 */
const CHAIN = {
  // get-params() on v2
  paramsHex:
    "0x0c0000000b07626f6e64427073010000000000000000000000000000000507647261774270730100000000000000000000000000000032076d696e426f6e6401000000000000000000000000000027100f6d696e5061727469636970616e74730100000000000000000000000000000002096d696e57656967687401000000000000000000000000000027100f70726f706f7365496e74657276616c01000000000000000000000000000000300a7665746f51756f72756d010000000000000000000000000000000f0a7665746f57696e646f77010000000000000000000000000000000c0a766f746557696e646f7701000000000000000000000000000000240c766f74696e6751756f72756d010000000000000000000000000000000f0f766f74696e675468726573686f6c640100000000000000000000000000000042",
  // get-phase("2026-07-20") on v2 -> "none" (no briefs proposed yet)
  phaseNoneHex: "0x0d000000046e6f6e65",
  // The briefDate argument the live node accepts
  briefDateArgHex: "0x0d0000000a323032362d30372d3230",
};

/** Live governance parameters, as read from get-params above. */
const PARAMS = {
  votingQuorum: 15,
  votingThreshold: 66,
  vetoQuorum: 15,
  minParticipants: 2,
  vetoWindow: 12,
  concludeWindow: 48,
};

/**
 * A realistic passing week. Tallies are taken from the v1 run; v2 has no
 * concluded week yet, so this exercises the arithmetic rather than replaying a
 * recorded verdict.
 */
const BRIEF = {
  voteEnd: 4_049_166,
  yesWeight: 18_000_000,
  noWeight: 0,
  vetoWeight: 0,
  voterCount: 2,
  eligibleSnapshot: 18_000_000,
  draw: 140_000,
  totalSignals: 50,
};

const RICH_POOL = 28_000_000;

describe("clarity decoder", () => {
  it("decodes the live get-params tuple field for field", () => {
    expect(toJSON(decodeClarityHex(CHAIN.paramsHex))).toEqual({
      bondBps: 5,
      drawBps: 50,
      minBond: 10_000,
      minParticipants: 2,
      minWeight: 10_000,
      proposeInterval: 48,
      vetoQuorum: 15,
      vetoWindow: 12,
      voteWindow: 36,
      votingQuorum: 15,
      votingThreshold: 66,
    });
  });

  it("decodes a get-phase string result", () => {
    expect(toJSON(decodeClarityHex(CHAIN.phaseNoneHex))).toBe("none");
  });

  it("round-trips a string-ascii argument byte-for-byte with the node", () => {
    expect(encodeStringAscii("2026-07-20")).toBe(CHAIN.briefDateArgHex);
    expect(toJSON(decodeClarityHex(CHAIN.briefDateArgHex))).toBe("2026-07-20");
  });

  it("decodes an optional-wrapped uint", () => {
    const v = decodeClarityHex("0x0a0100000000000000000000000000000001");
    expect(asNumber(unwrapOptional(v))).toBe(BRIEF_STATUS.PASSED);
  });

  it("decodes a nested tuple with mixed field types", () => {
    // (tuple (event "vote") (support true) (weight u9000000))
    const hex =
      "0x0c00000003" +
      "05" + "6576656e74" + "0d00000004766f7465" +
      "07" + "737570706f7274" + "03" +
      "06" + "776569676874" + "01" + "00000000000000000000000000895440";
    const value = decodeClarityHex(hex);
    expect(toJSON(value)).toEqual({ event: "vote", support: true, weight: 9_000_000 });
    expect(asNumber(tupleField(value, "weight"))).toBe(9_000_000);
  });

  it("rejects trailing bytes rather than silently ignoring them", () => {
    expect(() => decodeClarityHex(`${CHAIN.phaseNoneHex}ff`)).toThrow(ClarityDecodeError);
  });

  it("rejects an unknown type tag", () => {
    expect(() => decodeClarityHex("0x7f")).toThrow(ClarityDecodeError);
  });

  it("refuses to narrow an integer beyond the safe range", () => {
    const hex = `0x01${"10000000000000000000000000000000".padStart(32, "0")}`;
    expect(() => asNumber(decodeClarityHex(hex))).toThrow(ClarityDecodeError);
  });
});

describe("countdowns", () => {
  it("counts down to voteEnd while voting", () => {
    expect(blocksRemaining(BRIEF, "voting", BRIEF.voteEnd - 10, 12, 48)).toBe(10);
    expect(nextBoundaryHeight(BRIEF, "voting", 12, 48)).toBe(BRIEF.voteEnd);
  });

  it("counts down to vetoEnd during the veto window", () => {
    expect(blocksRemaining(BRIEF, "veto", BRIEF.voteEnd + 2, 12, 48)).toBe(10);
    expect(nextBoundaryHeight(BRIEF, "veto", 12, 48)).toBe(BRIEF.voteEnd + 12);
  });

  it("counts down the conclude window — the deadline that costs money", () => {
    // Boundary matches the contract: voteEnd + vetoWindow + concludeWindow.
    expect(nextBoundaryHeight(BRIEF, "concludable", 12, 48)).toBe(BRIEF.voteEnd + 60);
    expect(blocksRemaining(BRIEF, "concludable", BRIEF.voteEnd + 20, 12, 48)).toBe(40);
  });

  it("has no countdown once lapsed — the window is already gone", () => {
    expect(blocksRemaining(BRIEF, "lapsed", BRIEF.voteEnd + 999, 12, 48)).toBeNull();
    expect(nextBoundaryHeight(BRIEF, "lapsed", 12, 48)).toBeNull();
  });

  it("never reports a negative countdown past a boundary", () => {
    expect(blocksRemaining(BRIEF, "voting", BRIEF.voteEnd + 5, 12, 48)).toBe(0);
  });
});

describe("predictOutcome", () => {
  it("passes a week that clears every bar with a funded treasury", () => {
    expect(predictOutcome(BRIEF, PARAMS, RICH_POOL).outcome).toBe("PASSED");
  });

  it("fails on turnout when fewer than minParticipants voted, even at 100% approval", () => {
    const p = predictOutcome(
      { ...BRIEF, voterCount: 1, yesWeight: 9_000_000 },
      PARAMS,
      RICH_POOL
    );
    expect(p.outcome).toBe("NO_QUORUM");
    expect(p.approvalPct).toBe(100);
  });

  it("fails on turnout below the quorum", () => {
    const p = predictOutcome({ ...BRIEF, yesWeight: 1_000_000 }, PARAMS, RICH_POOL);
    expect(p.turnoutPct).toBeLessThan(PARAMS.votingQuorum);
    expect(p.outcome).toBe("NO_QUORUM");
  });

  it("is voted down when quorum is met but approval falls short", () => {
    const p = predictOutcome(
      { ...BRIEF, yesWeight: 9_000_000, noWeight: 9_000_000 },
      PARAMS,
      RICH_POOL
    );
    expect(p.quorumMet).toBe(true);
    expect(p.outcome).toBe("VOTED_DOWN");
  });

  it("treats a veto as dominant over an otherwise passing vote", () => {
    // Branch order is load-bearing: the contract tests veto before quorum.
    const p = predictOutcome({ ...BRIEF, vetoWeight: 2_700_000 }, PARAMS, RICH_POOL);
    expect(p.vetoPct).toBeGreaterThanOrEqual(PARAMS.vetoQuorum);
    expect(p.outcome).toBe("VETOED");
  });

  it("reports pool-short when the treasury cannot cover the snapshotted draw", () => {
    const p = predictOutcome(BRIEF, PARAMS, 1_000);
    expect(p.poolShort).toBe(true);
    expect(p.outcome).toBe("POOL_SHORT");
  });

  it("ranks a lost vote above a pool shortfall", () => {
    // Both conditions true: the reason a reader needs is the vote, not the pool.
    const p = predictOutcome(
      { ...BRIEF, yesWeight: 9_000_000, noWeight: 9_000_000 },
      PARAMS,
      1_000
    );
    expect(p.poolShort).toBe(true);
    expect(p.outcome).toBe("VOTED_DOWN");
  });

  it("compares the real disbursement, not the draw, against the balance", () => {
    // perSignal floors to 46666, so the true spend is 139998 — two sats under
    // the 140000 draw. A balance in that gap is still payable.
    const brief = { ...BRIEF, totalSignals: 3 };
    const p = predictOutcome(brief, PARAMS, 139_999);
    expect(p.perSignal).toBe(46_666);
    expect(p.poolShort).toBe(false);
    expect(p.outcome).toBe("PASSED");
  });

  it("short-circuits to not-concluded once lapsed, whatever the vote said", () => {
    // The contract tests lapsed before every other branch: a week that would
    // otherwise have passed still fails once the window closes.
    const p = predictOutcome(BRIEF, PARAMS, RICH_POOL, true);
    expect(p.outcome).toBe("NOT_CONCLUDED");
    expect(p.thresholdMet).toBe(true);
  });

  it("uses truncating division so a boundary predicts as the contract concludes", () => {
    // 65.9% approval truncates to 65, below the 66 threshold.
    const p = predictOutcome(
      { ...BRIEF, yesWeight: 6_590_000, noWeight: 3_410_000, eligibleSnapshot: 10_000_000 },
      PARAMS,
      RICH_POOL
    );
    expect(p.approvalPct).toBe(65);
    expect(p.thresholdMet).toBe(false);
    expect(p.outcome).toBe("VOTED_DOWN");
  });
});

describe("chainhook payload parsing", () => {
  /**
   * A real Chainhooks 2.0 delivery, shaped per the SDK's own TypeBox schemas.
   * The first parser was written against classic Chainhook and matched none of
   * this — and because a mismatch yields zero events rather than an error, the
   * service saw healthy 200s while nothing was ever indexed. These assertions
   * exist so that failure mode cannot recur silently.
   */
  const delivery = {
    chainhook: { uuid: "f0f6a9bc", name: "legion-gov-events" },
    event: {
      chain: "stacks",
      network: "testnet",
      rollback: [],
      apply: [
        {
          block_identifier: { index: 4_049_436 },
          timestamp: 1_784_823_000,
          metadata: { burn_block_timestamp: 1_784_823_100 },
          transactions: [
            {
              transaction_identifier: { hash: "0x5309576f865f" },
              metadata: { status: "success" },
              operations: [
                { type: "stx_transfer", operation_identifier: { index: 0 } },
                {
                  type: "contract_log",
                  operation_identifier: { index: 1 },
                  metadata: {
                    contract_identifier: LEGION_GOV_CONTRACT,
                    topic: "print",
                    value: {
                      event: "contribute",
                      who: "STGX5YP51NKM69ZMP6DVB6GAJAANCG5WB3718KD9",
                      amount: 10_000_000,
                    },
                  },
                },
              ],
            },
            {
              // An aborted tx must never be indexed as if it happened.
              transaction_identifier: { hash: "0xdeadbeef" },
              metadata: { status: "abort_by_post_condition" },
              operations: [
                {
                  type: "contract_log",
                  operation_identifier: { index: 0 },
                  metadata: {
                    contract_identifier: LEGION_GOV_CONTRACT,
                    topic: "print",
                    value: { event: "conclude", briefDate: "2026-07-23" },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };

  it("extracts print events from the nested event.apply path", () => {
    const rows = extractEvents(delivery.event.apply, LEGION_GOV_CONTRACT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      txid: "0x5309576f865f",
      event: "contribute",
      block_height: 4_049_436,
      event_index: 1,
    });
  });

  it("skips operations from other contracts", () => {
    const rows = extractEvents(delivery.event.apply, "SP000000000000000000002Q6VF78.other");
    expect(rows).toHaveLength(0);
  });

  it("decodes a value delivered as hex rather than a decoded object", () => {
    // Falls back to the local codec, so indexing does not depend on the
    // service honouring decode_clarity_values.
    const hex =
      "0x0c00000002" +
      "05" + "6576656e74" + "0d0000000a636f6e747269627574" + "65" +
      "06" + "616d6f756e74" + "01" + "00000000000000000000000000989680";
    const rows = extractEvents(
      [
        {
          block_identifier: { index: 1 },
          transactions: [
            {
              transaction_identifier: { hash: "0xabc" },
              metadata: { status: "success" },
              operations: [
                {
                  type: "contract_log",
                  operation_identifier: { index: 0 },
                  metadata: { contract_identifier: LEGION_GOV_CONTRACT, value: hex },
                },
              ],
            },
          ],
        },
      ],
      LEGION_GOV_CONTRACT
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe("contribute");
    expect(rows[0].data.amount).toBe(10_000_000);
  });
});
