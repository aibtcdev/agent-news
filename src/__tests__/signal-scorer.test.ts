import { describe, it, expect } from "vitest";
import { scoreSignal } from "../lib/signal-scorer";

/**
 * Unit tests for the signal quality auto-scorer.
 * All tests are pure — no network, no DB, no cloudflare bindings needed.
 */

const MINIMAL_SIGNAL = {
  headline: "Bitcoin price rises",
  body: null,
  sources: [],
  tags: [],
  beat_slug: "agent-economy",
  disclosure: null,
};

describe("scoreSignal — sourceQuality dimension", () => {
  it("returns 0 pts for zero sources", () => {
    const result = scoreSignal({ ...MINIMAL_SIGNAL, sources: [] });
    expect(result.breakdown.sourceQuality).toBe(0);
  });

  it("returns 10 pts for 1 source", () => {
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      sources: [{ url: `https://example.com/news/${new Date().getFullYear()}/article`, title: "Example" }],
    });
    expect(result.breakdown.sourceQuality).toBe(10);
  });

  it("returns 20 pts for 2 sources", () => {
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      sources: [
        { url: "https://example.com/a", title: "A" },
        { url: "https://example2.com/b", title: "B" },
      ],
    });
    expect(result.breakdown.sourceQuality).toBe(20);
  });

  it("returns 30 pts for 3+ sources", () => {
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      sources: [
        { url: "https://a.com", title: "A" },
        { url: "https://b.com", title: "B" },
        { url: "https://c.com", title: "C" },
      ],
    });
    expect(result.breakdown.sourceQuality).toBe(30);
  });
});

describe("scoreSignal — thesisClarity dimension", () => {
  it("gives 5 pts for a headline that is too short (< 5 words)", () => {
    const result = scoreSignal({ ...MINIMAL_SIGNAL, headline: "Bitcoin rises" });
    expect(result.breakdown.thesisClarity).toBe(5);
  });

  it("gives 10 pts for headline with 5–7 words", () => {
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      headline: "Bitcoin hits new all-time high today",
    });
    expect(result.breakdown.thesisClarity).toBe(10);
  });

  it("gives 15 pts for headline with 8–15 words", () => {
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      headline: "Bitcoin breaks one hundred thousand dollars driven by institutional ETF demand",
    });
    expect(result.breakdown.thesisClarity).toBe(15);
  });

  it("adds 10 pts bonus when body is longer than 200 chars, capped at 25", () => {
    const longBody = "A".repeat(201);
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      headline: "Bitcoin breaks one hundred thousand dollars driven by institutional ETF demand",
      body: longBody,
    });
    expect(result.breakdown.thesisClarity).toBe(25);
  });

  it("does not award body bonus for body <= 200 chars", () => {
    const shortBody = "Short body.";
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      headline: "Bitcoin breaks one hundred thousand dollars driven by institutional ETF demand",
      body: shortBody,
    });
    expect(result.breakdown.thesisClarity).toBe(15);
  });
});

describe("scoreSignal — beatRelevance dimension", () => {
  it("returns 0 pts when no tags", () => {
    const result = scoreSignal({ ...MINIMAL_SIGNAL, tags: [], beat_slug: "agent-economy" });
    expect(result.breakdown.beatRelevance).toBe(0);
  });

  it("returns 10 pts for 1 tag matching beat keyword", () => {
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      tags: ["agent"],
      beat_slug: "agent-economy",
    });
    expect(result.breakdown.beatRelevance).toBe(10);
  });

  it("returns 20 pts for 2+ tags matching beat keywords", () => {
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      tags: ["agent", "economy"],
      beat_slug: "agent-economy",
    });
    expect(result.breakdown.beatRelevance).toBe(20);
  });

  it("returns 0 pts when tags don't overlap with beat keywords", () => {
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      tags: ["ordinals", "runes"],
      beat_slug: "agent-economy",
    });
    expect(result.breakdown.beatRelevance).toBe(0);
  });
});

describe("scoreSignal — timeliness dimension", () => {
  it("returns 0 pts for empty sources", () => {
    const result = scoreSignal({ ...MINIMAL_SIGNAL, sources: [] });
    expect(result.breakdown.timeliness).toBe(0);
  });

  it("returns 15 pts when any source URL contains the current year", () => {
    const currentYear = new Date().getFullYear();
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      sources: [{ url: `https://news.example.com/${currentYear}/story`, title: "Story" }],
    });
    expect(result.breakdown.timeliness).toBe(15);
  });

  it("returns 15 pts when source URL contains previous year", () => {
    const prevYear = new Date().getFullYear() - 1;
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      sources: [{ url: `https://news.example.com/${prevYear}/story`, title: "Old Story" }],
    });
    expect(result.breakdown.timeliness).toBe(15);
  });

  it("returns 8 pts when no year match found in source URLs", () => {
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      sources: [{ url: "https://news.example.com/bitcoin-macro-story", title: "Story" }],
    });
    expect(result.breakdown.timeliness).toBe(8);
  });
});

describe("scoreSignal — disclosure dimension", () => {
  it("returns 0 pts for empty disclosure", () => {
    const result = scoreSignal({ ...MINIMAL_SIGNAL, disclosure: "" });
    expect(result.breakdown.disclosure).toBe(0);
  });

  it("returns 0 pts for null disclosure", () => {
    const result = scoreSignal({ ...MINIMAL_SIGNAL, disclosure: null });
    expect(result.breakdown.disclosure).toBe(0);
  });

  it("returns 5 pts for non-empty disclosure without tool/model mention", () => {
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      disclosure: "I researched this manually.",
    });
    expect(result.breakdown.disclosure).toBe(5);
  });

  it("returns 10 pts for disclosure mentioning claude", () => {
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      disclosure: "Researched using Claude with aibtc MCP tools.",
    });
    expect(result.breakdown.disclosure).toBe(10);
  });

  it("returns 10 pts for disclosure mentioning LLM", () => {
    const result = scoreSignal({
      ...MINIMAL_SIGNAL,
      disclosure: "LLM-assisted research with manual verification.",
    });
    expect(result.breakdown.disclosure).toBe(10);
  });
});

describe("scoreSignal — total and shape", () => {
  it("total equals sum of all breakdown dimensions", () => {
    const currentYear = new Date().getFullYear();
    const result = scoreSignal({
      headline: "Agent economy signals new wave of sBTC payment adoption on Stacks network",
      body: "A".repeat(250),
      sources: [
        { url: `https://stacks.org/${currentYear}/news`, title: "Stacks News" },
        { url: `https://aibtc.com/${currentYear}/updates`, title: "AIBTC Updates" },
        { url: `https://x.com/${currentYear}/post`, title: "Post" },
      ],
      tags: ["agent", "economy", "sbtc"],
      beat_slug: "agent-economy",
      disclosure: "Researched using Claude and aibtc MCP skills.",
    });
    const { sourceQuality, thesisClarity, beatRelevance, timeliness, disclosure } =
      result.breakdown;
    expect(result.total).toBe(
      sourceQuality + thesisClarity + beatRelevance + timeliness + disclosure
    );
  });

  it("returns a score between 0 and 100 inclusive", () => {
    const result = scoreSignal(MINIMAL_SIGNAL);
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(100);
  });

  it("returns maximum score of 100 for a fully-formed signal", () => {
    const currentYear = new Date().getFullYear();
    const result = scoreSignal({
      headline: "Agent economy signals new wave of sBTC payment adoption on Stacks network",
      body: "A".repeat(250),
      sources: [
        { url: `https://stacks.org/${currentYear}/news`, title: "Stacks News" },
        { url: `https://aibtc.com/${currentYear}/updates`, title: "AIBTC Updates" },
        { url: `https://x.com/${currentYear}/post`, title: "Post" },
      ],
      tags: ["agent", "economy"],
      beat_slug: "agent-economy",
      disclosure: "Researched using Claude and aibtc MCP skills.",
    });
    expect(result.total).toBe(100);
  });
});
