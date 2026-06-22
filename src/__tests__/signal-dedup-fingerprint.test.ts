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
});
