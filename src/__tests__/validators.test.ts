import { describe, it, expect } from "vitest";
import {
  validateBtcAddress,
  validateSlug,
  validateHexColor,
  sanitizeString,
  validateHeadline,
  validateSources,
  validateTags,
  validateSignatureFormat,
  checkDisclosureIdentity,
} from "../lib/validators";

const VALID_BTC_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

describe("validateBtcAddress", () => {
  it("accepts a valid bech32 bc1 address", () => {
    expect(validateBtcAddress(VALID_BTC_ADDRESS)).toBe(true);
  });

  it("rejects non-string values", () => {
    expect(validateBtcAddress(null)).toBe(false);
    expect(validateBtcAddress(undefined)).toBe(false);
    expect(validateBtcAddress(123)).toBe(false);
  });

  it("rejects legacy addresses (P2PKH)", () => {
    expect(validateBtcAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf"))
      .toBe(false);
  });

  it("rejects addresses not starting with bc1", () => {
    expect(validateBtcAddress("tb1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"))
      .toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateBtcAddress("")).toBe(false);
  });
});

describe("validateSlug", () => {
  it("accepts a valid 3-char slug", () => {
    expect(validateSlug("abc")).toBe(true);
    expect(validateSlug("a1b")).toBe(true);
  });

  it("accepts valid slugs with hyphens", () => {
    expect(validateSlug("my-beat")).toBe(true);
    expect(validateSlug("my-long-beat-slug")).toBe(true);
  });

  it("rejects slugs starting or ending with hyphen", () => {
    expect(validateSlug("-beat")).toBe(false);
    expect(validateSlug("beat-")).toBe(false);
  });

  it("rejects uppercase characters", () => {
    expect(validateSlug("MyBeat")).toBe(false);
  });

  it("rejects too-short slugs", () => {
    expect(validateSlug("ab")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(validateSlug(null)).toBe(false);
    expect(validateSlug(123)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateSlug("")).toBe(false);
  });
});

describe("validateHexColor", () => {
  it("accepts valid #RRGGBB colors", () => {
    expect(validateHexColor("#FF0000")).toBe(true);
    expect(validateHexColor("#00ff00")).toBe(true);
    expect(validateHexColor("#123abc")).toBe(true);
  });

  it("rejects shorthand 3-digit colors", () => {
    expect(validateHexColor("#FFF")).toBe(false);
  });

  it("rejects colors without #", () => {
    expect(validateHexColor("FF0000")).toBe(false);
  });

  it("rejects invalid hex characters", () => {
    expect(validateHexColor("#GGHHII")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(validateHexColor(null)).toBe(false);
    expect(validateHexColor(undefined)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateHexColor("")).toBe(false);
  });
});

describe("sanitizeString", () => {
  it("trims leading/trailing whitespace", () => {
    expect(sanitizeString("  hello  ")).toBe("hello");
  });

  it("truncates to the given max length", () => {
    expect(sanitizeString("abcde", 3)).toBe("abc");
  });

  it("uses default max of 500 when not specified", () => {
    const long = "a".repeat(600);
    expect(sanitizeString(long).length).toBe(500);
  });

  it("returns empty string for non-string input", () => {
    expect(sanitizeString(null)).toBe("");
    expect(sanitizeString(undefined)).toBe("");
    expect(sanitizeString(123)).toBe("");
  });
});

describe("validateHeadline", () => {
  it("accepts a normal headline", () => {
    expect(validateHeadline("Bitcoin rises above $100k")).toBe(true);
  });

  it("accepts single character", () => {
    expect(validateHeadline("A")).toBe(true);
  });

  it("accepts exactly 120 characters", () => {
    expect(validateHeadline("a".repeat(120))).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateHeadline("")).toBe(false);
  });

  it("rejects strings longer than 120 characters", () => {
    expect(validateHeadline("a".repeat(121))).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(validateHeadline(null)).toBe(false);
    expect(validateHeadline(undefined)).toBe(false);
  });
});

describe("validateSources", () => {
  const validSource = { url: "https://example.com", title: "Example" };

  it("accepts a valid sources array", () => {
    expect(validateSources([validSource])).toBe(true);
  });

  it("accepts up to 5 sources", () => {
    expect(validateSources(Array(5).fill(validSource))).toBe(true);
  });

  it("rejects empty array", () => {
    expect(validateSources([])).toBe(false);
  });

  it("rejects more than 5 sources", () => {
    expect(validateSources(Array(6).fill(validSource))).toBe(false);
  });

  it("rejects sources without url", () => {
    expect(validateSources([{ title: "Test" }])).toBe(false);
  });

  it("rejects sources with empty url", () => {
    expect(validateSources([{ url: "", title: "Test" }])).toBe(false);
  });

  it("rejects sources without title", () => {
    expect(validateSources([{ url: "https://example.com" }])).toBe(false);
  });

  it("rejects sources with empty title", () => {
    expect(validateSources([{ url: "https://example.com", title: "" }]))
      .toBe(false);
  });

  it("rejects non-array", () => {
    expect(validateSources("not-array")).toBe(false);
    expect(validateSources(null)).toBe(false);
  });
});

describe("validateTags", () => {
  it("accepts valid tags", () => {
    expect(validateTags(["bitcoin", "defi", "nft"])).toBe(true);
  });

  it("accepts tags with hyphens", () => {
    expect(validateTags(["crypto-news", "layer-two"])).toBe(true);
  });

  it("accepts up to 10 tags", () => {
    expect(validateTags(Array(10).fill("tag"))).toBe(true);
  });

  it("rejects empty array", () => {
    expect(validateTags([])).toBe(false);
  });

  it("rejects more than 10 tags", () => {
    expect(validateTags(Array(11).fill("tag"))).toBe(false);
  });

  it("rejects uppercase tags", () => {
    expect(validateTags(["Bitcoin"])).toBe(false);
  });

  it("rejects single-character tags (min 2 chars)", () => {
    expect(validateTags(["a"])).toBe(false);
  });

  it("rejects tags longer than 30 chars", () => {
    expect(validateTags(["a".repeat(31)])).toBe(false);
  });

  it("rejects non-array", () => {
    expect(validateTags("not-array")).toBe(false);
    expect(validateTags(null)).toBe(false);
  });
});

describe("validateSignatureFormat", () => {
  it("accepts valid base64 signatures", () => {
    const sig = "AAAA".repeat(20); // 80 chars, all valid base64
    expect(validateSignatureFormat(sig)).toBe(true);
  });

  it("rejects too-short strings (< 20 chars)", () => {
    expect(validateSignatureFormat("short")).toBe(false);
  });

  it("rejects too-long strings (> 200 chars)", () => {
    expect(validateSignatureFormat("a".repeat(201))).toBe(false);
  });

  it("rejects non-base64 characters", () => {
    expect(validateSignatureFormat("!@#$".repeat(10))).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(validateSignatureFormat(null)).toBe(false);
    expect(validateSignatureFormat(undefined)).toBe(false);
  });
});

describe("checkDisclosureIdentity", () => {
  it("returns ok when disclosure is missing", () => {
    // Signals without a disclosure field must not be blocked by this gate.
    expect(checkDisclosureIdentity(undefined, "Humble Panther")).toEqual({ ok: true });
    expect(checkDisclosureIdentity(null, "Humble Panther")).toEqual({ ok: true });
    expect(checkDisclosureIdentity("", "Humble Panther")).toEqual({ ok: true });
  });

  it("returns ok when disclosure names the filer themselves", () => {
    // Canonical clean case: a Humble Panther filing whose disclosure
    // correctly says "Humble Panther agent".
    const result = checkDisclosureIdentity(
      "Humble Panther agent, live data from mempool.space. 2026-07-11.",
      "Humble Panther"
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects the canonical cross-contamination fixture (2b96b7ac)", () => {
    // On 2026-07-04, signal 2b96b7ac was filed under displayName "Tall Jett"
    // but its disclosure field read "Humble Panther agent, live data from
    // mempool.space" — copy-pasted automation prompt leaked the original
    // filer identity. This is exactly the case the gate is designed for.
    const result = checkDisclosureIdentity(
      "Humble Panther agent, live data from mempool.space. 2026-07-04.",
      "Tall Jett"
    );
    expect(result).toEqual({ ok: false, conflict: "Humble Panther" });
  });

  it("rejects Filed-by shape when disclosure names a different agent", () => {
    const result = checkDisclosureIdentity(
      "Filed by Opal Gorilla — automated wave-scan pipeline.",
      "Graphite Elan"
    );
    expect(result).toEqual({ ok: false, conflict: "Opal Gorilla" });
  });

  it("returns ok when disclosure contains no agent-name pattern", () => {
    // Plain-model disclosures (no "<Name> agent" or "Filed by <Name>"
    // phrase) must not trigger the gate.
    const result = checkDisclosureIdentity(
      "claude-opus-4-7, aibtc MCP tools, live GitHub API data.",
      "Quiet Falcon"
    );
    expect(result).toEqual({ ok: true });
  });

  it("returns ok when filerDisplayName is empty (fail-open)", () => {
    // If the caller cannot resolve the filer's displayName, the gate
    // must not block the write — matching the codebase's fail-open
    // preference for identity-resolution ambiguity.
    const result = checkDisclosureIdentity(
      "Humble Panther agent, live data from mempool.space.",
      ""
    );
    expect(result).toEqual({ ok: true });
  });

  // Lowercase disclosures are treated as fail-open by design (Sonic Mast
  // #862 re-review, 2026-07-12). After dropping /i, the detection regex is
  // Title-Case only, so a lowercase phrase like "humble panther agent" is
  // not detected at all. That falls through to { ok: true } — same result
  // as the earlier case-insensitive self-match path, different reason.
  // Trade-off: a lowercase-conflict disclosure would also slip through
  // undetected (see the next test). Accepted for a cheap fail-open pre-filter.
  it("falls open on lowercase disclosures (detection is Title-Case only)", () => {
    const result = checkDisclosureIdentity(
      "humble panther agent, live data from mempool.space.",
      "Humble Panther"
    );
    expect(result).toEqual({ ok: true });
  });

  it("does NOT catch lowercase-conflict disclosures (accepted fail-open)", () => {
    // Explicit test of the tradeoff Sonic Mast flagged: an all-lowercase
    // disclosure that names a DIFFERENT agent than the filer is not caught
    // by this gate. The design intent is a cheap pre-filter for the copy-
    // paste case (which preserves capitalization), not a comprehensive
    // enforcement pass. A later gate would need to normalize disclosure
    // casing pre-detection if this class matters.
    const result = checkDisclosureIdentity(
      "humble panther agent, live data from mempool.space.",
      "Tall Jett"
    );
    expect(result).toEqual({ ok: true });
  });

  it("normalizes whitespace on the self-match", () => {
    // Extra internal whitespace on either side must not break the self-match.
    const result = checkDisclosureIdentity(
      "Humble  Panther  agent, live data from mempool.space.",
      "Humble Panther"
    );
    expect(result).toEqual({ ok: true });
  });

  it("still rejects cross-contamination when casing differs from filer", () => {
    // Case-insensitive compare must not swallow the real conflict signal.
    // The disclosure names a different agent than the filer (even with
    // casing drift on the filer side).
    const result = checkDisclosureIdentity(
      "Humble Panther agent, live data from mempool.space.",
      "tall jett"
    );
    expect(result).toEqual({ ok: false, conflict: "Humble Panther" });
  });

  it("normalizes whitespace on the filer side of the self-match too", () => {
    // Symmetry test: whitespace drift on the FILER side must also fail open.
    // This exercises the filerNormalized branch of normalize() (vs the prior
    // test which exercised the disclosed side).
    const result = checkDisclosureIdentity(
      "Humble Panther agent, live data from mempool.space.",
      "  Humble\tPanther  "
    );
    expect(result).toEqual({ ok: true });
  });

  it("still rejects when disclosure has whitespace drift but names a different agent", () => {
    // Stress test: the disclosure has double-space drift on the name AND
    // the filer is a completely different agent. The updated `\\s+` regex
    // must still extract the name, and normalize() must still detect the
    // real conflict — the whitespace fix must not swallow the signal.
    const result = checkDisclosureIdentity(
      "Humble  Panther  agent, live data from mempool.space.",
      "Tall Jett"
    );
    expect(result).toEqual({ ok: false, conflict: "Humble  Panther" });
  });

  // False-positive gap surfaced in Sonic Mast's #862 review (2026-07-12):
  // the prior /i + greedy repetition combo captured entire lowercase clauses
  // ending in the literal word "agent", producing hard-rejects on plausible
  // disclosure prose. Locking the detection regex to Title-Case and capping
  // the name at 3 words prevents that class of false-positive.
  it("does not capture ordinary lowercase phrases ending in the word 'agent'", () => {
    expect(
      checkDisclosureIdentity(
        "This signal was generated by our automated trading agent pipeline.",
        "Sonic Mast"
      )
    ).toEqual({ ok: true });
    expect(
      checkDisclosureIdentity(
        "Data verified via background monitoring agent at 07:00Z.",
        "Sonic Mast"
      )
    ).toEqual({ ok: true });
    expect(
      checkDisclosureIdentity(
        "Filed via our automated content-generation agent.",
        "Sonic Mast"
      )
    ).toEqual({ ok: true });
  });

  it("requires at least 2 Title-Case words (single word is not a name-shape)", () => {
    // A single Title-Case word before "agent" is not a plausible display name
    // and should not be captured. Fixtures all use 2-word names (Humble
    // Panther, Tall Jett, Opal Gorilla). This bounds the match to name-shaped
    // phrases and prevents a single sentence-start word from tripping the gate.
    const result = checkDisclosureIdentity(
      "Yesterday agent was quiet.",
      "Sonic Mast"
    );
    expect(result).toEqual({ ok: true });
  });
});
