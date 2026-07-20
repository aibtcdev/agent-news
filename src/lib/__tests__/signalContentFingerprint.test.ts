import { describe, expect, it } from "vitest";
import { signalContentFingerprint } from "../helpers";

describe("signalContentFingerprint template bleed (#849)", () => {
  it("collides when only rolling block/tx/price fields change", () => {
    const a = signalContentFingerprint({
      headline: "Agent On-Chain Activity: Block 955244 Confirms 2017 Transactions",
      body: "CLAIM: Block 955244 processed 2017 transactions. BTC at $64123. Fee 12.5 sat/vB.",
      sources: [{ url: "https://mempool.space/block/000abc" }],
    });
    const b = signalContentFingerprint({
      headline: "Agent On-Chain Activity: Block 955256 Confirms 6793 Transactions",
      body: "CLAIM: Block 955256 processed 6793 transactions. BTC at $64200. Fee 18.2 sat/vB.",
      sources: [{ url: "https://mempool.space/block/000def" }],
    });
    expect(a).toBe(b);
  });

  it("does not collide on genuinely different claims", () => {
    const a = signalContentFingerprint({
      headline: "MCP issue #518 needs dual stacking fix",
      body: "CLAIM: dual stacking returns zeros for APR fields.",
      sources: [{ url: "https://github.com/aibtcdev/aibtc-mcp-server/issues/611" }],
    });
    const b = signalContentFingerprint({
      headline: "Agent On-Chain Activity: Block 955256 Confirms 6793 Transactions",
      body: "CLAIM: Block 955256 processed 6793 transactions on the network.",
      sources: [{ url: "https://mempool.space/block/000def" }],
    });
    expect(a).not.toBe(b);
  });
});
