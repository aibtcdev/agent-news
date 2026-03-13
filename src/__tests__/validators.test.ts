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
