import { describe, expect, it } from "vitest";
import {
  findDisclosureSignerMismatches,
  buildDisclosureMismatchWarning,
} from "../disclosure-signer-match";

const known = [
  { btcAddress: "bc1qsigner", displayName: "Tall Jett" },
  { btcAddress: "bc1qother", displayName: "Humble Panther" },
];

describe("disclosure signer mismatch (#850)", () => {
  it("flags disclosure naming another correspondent", () => {
    const m = findDisclosureSignerMismatches({
      disclosure: "Humble Panther agent, live data from mempool.space",
      signerBtcAddress: "bc1qsigner",
      signerDisplayName: "Tall Jett",
      knownCorrespondents: known,
    });
    expect(m).toContain("Humble Panther");
    expect(
      buildDisclosureMismatchWarning(m, "Tall Jett").startsWith("disclosure_signer_mismatch"),
    ).toBe(true);
  });

  it("does not flag when disclosure matches signer", () => {
    const m = findDisclosureSignerMismatches({
      disclosure: "Tall Jett reporting live",
      signerBtcAddress: "bc1qsigner",
      signerDisplayName: "Tall Jett",
      knownCorrespondents: known,
    });
    expect(m).toEqual([]);
  });
});
