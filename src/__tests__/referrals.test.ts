import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("POST /api/referrals — validation", () => {
  it("returns 400 when body is not valid JSON", async () => {
    const res = await SELF.fetch("http://example.com/api/referrals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  // Note: subsequent POST tests hit the 1-per-week rate limit in the test environment,
  // so we only test the JSON parse error above. Full validation is tested via
  // the DO layer which rejects invalid inputs (self-referral, duplicates, etc.)
});
