import { describe, it, expect } from "vitest";
import { signalContentFingerprint } from "../lib/helpers";

/**
 * Unit tests for the filing-side dedup gate's content fingerprint (issue #845).
 * The DO compares this fingerprint between a fresh filing and the agent's
 * recently-rejected signals on the same beat; a match → HTTP 409. These tests
 * pin down exactly which edits collide (cosmetic) vs. which break the match
 * (a meaningful change the editor would re-review).
 */
describe("signalContentFingerprint", () => {
  const base = {
    headline: "Spark SDK ships PR #565",
    body: "Upstream merged the keeper changes.",
    sources: [{ url: "https://github.com/example/spark/pull/565" }],
  };

  it("is stable for identical content", () => {
    expect(signalContentFingerprint(base)).toBe(signalContentFingerprint({ ...base }));
  });

  it("collides on cosmetic whitespace / case differences (no meaningful edit)", () => {
    const cosmetic = {
      headline: "  Spark   SDK ships PR #565 ",
      body: "Upstream merged the KEEPER changes.",
      sources: [{ url: "https://github.com/example/spark/pull/565" }],
    };
    expect(signalContentFingerprint(cosmetic)).toBe(signalContentFingerprint(base));
  });

  it("differs when the primary source URL changes", () => {
    const other = {
      ...base,
      sources: [{ url: "https://github.com/example/spark/pull/566" }],
    };
    expect(signalContentFingerprint(other)).not.toBe(signalContentFingerprint(base));
  });

  it("differs when the body is meaningfully edited", () => {
    const edited = { ...base, body: "Upstream merged the keeper changes after review feedback." };
    expect(signalContentFingerprint(edited)).not.toBe(signalContentFingerprint(base));
  });

  it("differs when the headline changes", () => {
    const edited = { ...base, headline: "Spark SDK reverts PR #565" };
    expect(signalContentFingerprint(edited)).not.toBe(signalContentFingerprint(base));
  });

  it("keys off the primary (first) source only — reordering sources changes the fingerprint", () => {
    const reordered = {
      ...base,
      sources: [
        { url: "https://example.com/secondary" },
        { url: "https://github.com/example/spark/pull/565" },
      ],
    };
    expect(signalContentFingerprint(reordered)).not.toBe(signalContentFingerprint(base));
  });

  it("handles missing / empty body and sources without throwing", () => {
    expect(signalContentFingerprint({ headline: "x" })).toBe(
      signalContentFingerprint({ headline: "x", body: null, sources: [] })
    );
  });

  it("catches template-bleed: same template with different block/tx counts collapses (issue #849)", () => {
    const filing1 = {
      headline: "AIBTC Network Activity: Block 955244",
      body: "Block 955244 confirms 2017 transactions. IMPLICATION: For agents: defer when fastestFee > 80 sat/vB.",
      sources: [{ url: "https://mempool.space" }],
    };
    const filing2 = {
      headline: "AIBTC Network Activity: Block 955256",
      body: "Block 955256 confirms 6793 transactions. IMPLICATION: For agents: defer when fastestFee > 80 sat/vB.",
      sources: [{ url: "https://mempool.space" }],
    };
    expect(signalContentFingerprint(filing1)).toBe(signalContentFingerprint(filing2));
  });

  it("does not normalize years — year-only change with identical body stays distinct", () => {
    // Isolates a year-in-headline change with an otherwise identical body.
    // With a blanket \d{4,} regex both "2025" and "2026" collapse to "{N}",
    // falsely deduping signals that are genuinely different.
    const signal2025 = {
      headline: "SIP-031 Hard Fork scheduled for July 2025",
      body: "The upgrade targets the ecosystem.",
      sources: [{ url: "https://example.com/sip31" }],
    };
    const signal2026 = {
      headline: "SIP-031 Hard Fork scheduled for July 2026",
      body: "The upgrade targets the ecosystem.",
      sources: [{ url: "https://example.com/sip31" }],
    };
    expect(signalContentFingerprint(signal2025)).not.toBe(signalContentFingerprint(signal2026));
  });
});
