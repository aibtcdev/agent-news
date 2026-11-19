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

/**
 * Rolling-field normalization (#849, #852).
 *
 * The corpus below is the real one from #852: template re-files whose only
 * change between filings was a block height and a transaction count. Each
 * previously produced a distinct fingerprint, so the dedup gate never fired
 * and every one reached a human editor for a verdict already given.
 */
describe("signalContentFingerprint — rolling-field normalization", () => {
  const blockTemplate = (block: number, txs: number) => ({
    headline: `Agent On-Chain Activity: Block ${block} Confirms ${txs} Transactions`,
    body: `CLAIM: Block ${block} processed ${txs} transactions, reflecting sustained throughput.`,
    sources: [{ url: `https://mempool.space/block/${block}` }],
  });

  it("collides the #852 block-confirm corpus into one fingerprint", () => {
    // dc8ebbdb, 7f9a0a23, bb325e76, ea2c3271 — four filings, one template.
    const corpus = [
      blockTemplate(956719, 3273),
      blockTemplate(956723, 6885),
      blockTemplate(956731, 4241),
      blockTemplate(956735, 3333),
    ].map(signalContentFingerprint);

    expect(new Set(corpus).size).toBe(1);
  });

  it("collides price, fee-rate and percentage variants", () => {
    const priced = (usd: string, fee: string, pct: string) => ({
      headline: `BTC at ${usd}, mempool clearing at ${fee}`,
      body: `Network fees moved ${pct} over the session.`,
      sources: [{ url: "https://mempool.space" }],
    });
    expect(signalContentFingerprint(priced("$104,200", "12 sat/vB", "+3.2%"))).toBe(
      signalContentFingerprint(priced("$98,750.50", "7.5 sat/vB", "-1.8%"))
    );
  });

  it("collides bare dates as well as full timestamps", () => {
    // The catch-all alone would eat only the year, leaving {NUM}-07-04 vs
    // {NUM}-07-05 distinct — the dedicated rule has to cover date-only form.
    const dated = (d: string) => ({
      headline: `Daily throughput report for ${d}`,
      body: `Snapshot captured ${d}.`,
      sources: [{ url: "https://example.com/report" }],
    });
    expect(signalContentFingerprint(dated("2026-07-04"))).toBe(
      signalContentFingerprint(dated("2026-07-05"))
    );
    expect(signalContentFingerprint(dated("2026-07-04T12:00:00Z"))).toBe(
      signalContentFingerprint(dated("2026-07-05T18:30:00Z"))
    );
  });

  it("normalizes an unlabeled rolling field via the catch-all", () => {
    // The backstop for a field no labeled rule anticipates.
    const withConfirmations = (n: number) => ({
      headline: "Peg-in router status",
      body: `confirmations: ${n}`,
      sources: [{ url: "https://example.com/peg" }],
    });
    expect(signalContentFingerprint(withConfirmations(12345))).toBe(
      signalContentFingerprint(withConfirmations(67890))
    );
  });

  // ── The other half: things that must NOT collide ──

  it("keeps genuinely different stories distinct", () => {
    // d4bf1cf0 (difficulty trajectory) vs e26109b0 (MSTR/Kash Patel) — the
    // #852 corpus's stated negative controls.
    const difficulty = {
      headline: "Difficulty Epoch 62% Complete: Trajectory Reverses",
      body: "CLAIM: the retarget now points lower.",
      sources: [{ url: "https://mempool.space/mining" }],
    };
    const mstr = {
      headline: "MSTR adds to treasury as Patel confirms position",
      body: "CLAIM: the filing shows a further purchase.",
      sources: [{ url: "https://sec.gov/filing" }],
    };
    expect(signalContentFingerprint(difficulty)).not.toBe(
      signalContentFingerprint(mstr)
    );
  });

  it("keeps the rolling-story series distinct via its verb", () => {
    // The false-positive case flagged in #852: same headline template, same
    // retarget target, only the progress % and the directional verb change.
    // Verbs are text, not numbers, so normalization leaves them separating.
    const trajectory = (pct: string, verb: string) => ({
      headline: `Difficulty Epoch ${pct} Complete: Trajectory ${verb}`,
      body: `CLAIM: adjustment tracking toward the July retarget.`,
      sources: [{ url: "https://mempool.space/mining" }],
    });
    const reverses = signalContentFingerprint(trajectory("42%", "Reverses"));
    const recovers = signalContentFingerprint(trajectory("45%", "Recovers"));
    const corrects = signalContentFingerprint(trajectory("48%", "Corrects"));
    expect(new Set([reverses, recovers, corrects]).size).toBe(3);
  });

  it("keeps short identifying numbers intact (PR / BIP numbers)", () => {
    // 1-3 digit runs are left alone: PR #565 and PR #566 are different stories.
    const pr = (n: number) => ({
      headline: `Spark SDK ships PR #${n}`,
      body: "Upstream merged the keeper changes.",
      sources: [{ url: `https://github.com/example/spark/pull/${n}` }],
    });
    expect(signalContentFingerprint(pr(565))).not.toBe(signalContentFingerprint(pr(566)));
  });

  it("keeps 4+ digit PR and issue numbers distinct (#915)", () => {
    // Explicit references become a token the catch-all can't reach.
    const pr = (n: number) => ({
      headline: `landing-page PR #${n} merged`,
      body: "Adds retry on Hiro 429.",
      sources: [{ url: `https://github.com/aibtcdev/landing-page/pull/${n}` }],
    });
    expect(signalContentFingerprint(pr(1024))).not.toBe(signalContentFingerprint(pr(1031)));

    // Either reference alone is enough to keep two stories apart.
    const urlOnly = (n: number) => ({ ...pr(n), headline: "landing-page PR merged" });
    expect(signalContentFingerprint(urlOnly(1024))).not.toBe(signalContentFingerprint(urlOnly(1031)));
    const issue = (n: number) => ({
      headline: `Hiro lag fixed (#${n})`,
      body: "Closes the retry gap.",
      sources: [{ url: `https://github.com/aibtcdev/landing-page/issues/${n}` }],
    });
    expect(signalContentFingerprint(issue(1146))).not.toBe(signalContentFingerprint(issue(1147)));
  });

  // #916 review: a non-GitHub source, so only the headline reference separates these.
  it.each([
    ["landing-page PR 1024 merged", "landing-page PR 1031 merged"],
    ["Hiro lag fixed in issue #1146", "Hiro lag fixed in issue #1147"],
    ["landing-page PR #1,024 merged", "landing-page PR #1,031 merged"],
    // #916 second review: `tx` after the number used to win via {TX_COUNT}.
    ["Bitcoin Core PR 31234 tx relay fix", "Bitcoin Core PR 31240 tx relay fix"],
    ["Bitcoin Core PR #31234: 2 transactions per package", "Bitcoin Core PR #31240: 2 transactions per package"],
    // Shorthand and lists.
    ["aibtcdev/landing-page#1024 merged", "aibtcdev/landing-page#1031 merged"],
    ["landing-page#1024 merged", "landing-page#1031 merged"],
    ["landing-page PRs #1024 and #1025", "landing-page PRs #2001 and #2002"],
    ["landing-page PRs #1024 and #1025", "landing-page PRs #1024 and #1026"],
    ["landing-page PRs #1024, #1025", "landing-page PRs #1024, #1026"],
    ["Hiro issues #1146 and #1147 closed", "Hiro issues #1146 and #1148 closed"],
  ])("keeps the reference in %j distinct from %j", (a, b) => {
    const titled = (headline: string) => ({
      headline,
      body: "Adds retry on Hiro 429.",
      sources: [{ url: "https://example.com/changelog" }],
    });
    expect(signalContentFingerprint(titled(a))).not.toBe(signalContentFingerprint(titled(b)));
  });

  it("keeps `/pulls/N` API URLs distinct (#916 review)", () => {
    const api = (n: number) => ({
      headline: "landing-page PR merged",
      body: "Adds retry on Hiro 429.",
      sources: [{ url: `https://api.github.com/repos/aibtcdev/landing-page/pulls/${n}` }],
    });
    expect(signalContentFingerprint(api(1024))).not.toBe(signalContentFingerprint(api(1031)));
  });

  it("still collapses a 4+ digit rolling number that is not a PR or issue reference", () => {
    // Same PR, only the rolling count changes: still one story.
    const status = (n: number) => ({
      headline: "landing-page PR #1147 status",
      body: `confirmations: ${n}`,
      sources: [{ url: "https://github.com/aibtcdev/landing-page/pull/1147" }],
    });
    expect(signalContentFingerprint(status(12345))).toBe(signalContentFingerprint(status(67890)));
  });

  // #916 review: a bare `#N` is not a reference on its own, so these fall
  // through to the catch-all and a re-file that only bumps the number still
  // hits the 409.
  it.each([
    ["Bitcoin block #945123 mined", "Bitcoin block #945124 mined"],
    ["Bitcoin block height #945123 mined", "Bitcoin block height #945124 mined"],
    ["Mempool nonce #12345 stuck", "Mempool nonce #12346 stuck"],
    ["Bitcoin block #945,123", "Bitcoin block #945,124"],
    ["Mempool nonce#12345 stuck", "Mempool nonce#12346 stuck"],
  ])("still collapses the `#`-spelled rolling field in %j and %j", (a, b) => {
    const filed = (headline: string) => ({
      headline,
      body: "fees 12 sat/vB",
      sources: [{ url: "https://mempool.space" }],
    });
    expect(signalContentFingerprint(filed(a))).toBe(signalContentFingerprint(filed(b)));
  });

  // #916 second review: `issue` is also a verb. Without a `#` it is not a
  // reference, so an amount after it stays a rolling field (as on main).
  it.each([
    ["Stacks DAO to issue 21000 sBTC", "Stacks DAO to issue 22000 sBTC"],
    ["Treasury will Issue 1,500,000 tokens", "Treasury will Issue 1,750,000 tokens"],
    ["DAO issues 25000 STX in grants", "DAO issues 30000 STX in grants"],
  ])("still collapses the amount after the verb in %j and %j", (a, b) => {
    const filed = (headline: string) => ({
      headline,
      body: "fees 12 sat/vB",
      sources: [{ url: "https://mempool.space" }],
    });
    expect(signalContentFingerprint(filed(a))).toBe(signalContentFingerprint(filed(b)));
  });
});

/**
 * Regression coverage for the review finding on #849: the original tx-count
 * rule keyed off a "tx"/"txs" abbreviation that filing templates never use
 * (they write "Transactions"), so it matched nothing and the 4+ digit
 * catch-all silently did its job. That safety net vanishes below 1000, which
 * left sub-1000 counts denormalised — the exact bug class #849 reports, in a
 * narrower range the original fixtures never exercised.
 */
describe("signalContentFingerprint — transaction counts across the value range", () => {
  const confirms = (block: number, txs: number) => ({
    headline: `Agent On-Chain Activity: Block ${block} Confirms ${txs} Transactions`,
    body: `CLAIM: Block ${block} processed ${txs} transactions.`,
    sources: [{ url: "https://mempool.space" }],
  });

  it("collides sub-1000 transaction counts (below the catch-all floor)", () => {
    expect(signalContentFingerprint(confirms(956719, 273))).toBe(
      signalContentFingerprint(confirms(956723, 42))
    );
  });

  it("collides across the 1000 boundary", () => {
    // A 3-digit and a 4+ digit count must reach the same placeholder, or the
    // fingerprint would depend on which rule happened to fire.
    expect(signalContentFingerprint(confirms(956719, 999))).toBe(
      signalContentFingerprint(confirms(956723, 3273))
    );
  });

  it("normalizes the abbreviated spelling identically to the long form", () => {
    const long = {
      headline: "Block 956719 Confirms 3273 Transactions",
      body: null,
      sources: [{ url: "https://mempool.space" }],
    };
    const abbrev = {
      headline: "Block 956723 Confirms 4241 txs",
      body: null,
      sources: [{ url: "https://mempool.space" }],
    };
    expect(signalContentFingerprint(long)).toBe(signalContentFingerprint(abbrev));
  });

  it("still keeps short PR numbers distinct — the word is what disambiguates", () => {
    // Dropping the digit floor must not start collapsing bare identifiers.
    const pr = (n: number) => ({
      headline: `Spark SDK ships PR #${n}`,
      body: "Upstream merged the keeper changes.",
      sources: [{ url: `https://github.com/example/spark/pull/${n}` }],
    });
    expect(signalContentFingerprint(pr(565))).not.toBe(signalContentFingerprint(pr(566)));
  });
});
