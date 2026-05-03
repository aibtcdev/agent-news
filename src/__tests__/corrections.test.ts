import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("POST /api/signals/:id/corrections — validation", () => {
  it("returns 400 when body is not valid JSON", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/corrections",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "not-json" }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/corrections",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("claim must be a non-empty string");
  });

  it("returns 400 for invalid BTC address", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/corrections",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          btc_address: "invalid",
          claim: "Wrong TVL",
          correction: "Correct TVL is X",
        }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("BTC address");
  });

  it("returns 400 for invalid type value", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/corrections",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.4" },
        body: JSON.stringify({
          btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
          type: "bogus",
        }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("Invalid type");
  });
});

describe("POST /api/signals/:id/corrections — editorial_review validation", () => {
  const url = "http://example.com/api/signals/test-id/corrections";
  const base = {
    btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    type: "editorial_review",
  };

  let ipCounter = 0;
  const post = (body: Record<string, unknown>) =>
    SELF.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": `10.0.1.${++ipCounter}`,
      },
      body: JSON.stringify({ ...base, ...body }),
    });

  it("returns 400 when score is not an integer", async () => {
    const res = await post({ score: 55.5 });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("score must be an integer between 0 and 100");
  });

  it("returns 400 when score is below 0", async () => {
    const res = await post({ score: -1 });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("score must be an integer between 0 and 100");
  });

  it("returns 400 when score is above 100", async () => {
    const res = await post({ score: 101 });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("score must be an integer between 0 and 100");
  });

  it("returns 400 when score is not a number", async () => {
    const res = await post({ score: "high" });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("score must be an integer between 0 and 100");
  });

  it("returns 400 when factcheck_passed is not a boolean", async () => {
    const res = await post({ factcheck_passed: 1 });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("factcheck_passed must be a boolean");
  });

  it("returns 400 when beat_relevance is not an integer", async () => {
    const res = await post({ beat_relevance: 42.7 });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("beat_relevance must be an integer between 0 and 100");
  });

  it("returns 400 when beat_relevance is out of range", async () => {
    const res = await post({ beat_relevance: 200 });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("beat_relevance must be an integer between 0 and 100");
  });

  it("returns 400 when recommendation is not a valid enum value", async () => {
    const res = await post({ recommendation: "maybe" });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("recommendation must be one of");
  });

  it("returns 400 when recommendation is not a string", async () => {
    const res = await post({ recommendation: 42 });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("recommendation must be one of");
  });

  it("returns 400 when feedback is not a string", async () => {
    const res = await post({ feedback: 123 });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("feedback must be a string");
  });

  it("passes validation with valid editorial_review fields", async () => {
    const res = await post({
      score: 85,
      factcheck_passed: true,
      beat_relevance: 70,
      recommendation: "approve",
      feedback: "Solid sourcing, well-structured signal.",
    });
    // Should pass route validation and reach auth layer (401) or DO
    expect(res.status).not.toBe(400);
  });

  it("passes validation with only some editorial fields", async () => {
    const res = await post({ recommendation: "needs_revision" });
    expect(res.status).not.toBe(400);
  });

  it("passes validation with no editorial fields (all optional)", async () => {
    const res = await post({});
    expect(res.status).not.toBe(400);
  });
});

describe("GET /api/signals/:id/corrections", () => {
  it("returns 200 with corrections list shape", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/nonexistent/corrections"
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ corrections: unknown[]; total: number }>();
    expect(Array.isArray(body.corrections)).toBe(true);
    expect(typeof body.total).toBe("number");
  });
});

describe("PATCH /api/signals/:id/corrections/:correctionId — validation", () => {
  it("returns 400 when required fields are missing", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/corrections/corr-id",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("status");
  });

  it("returns 400 for invalid status value", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/corrections/corr-id",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
          status: "pending",
        }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("approved");
  });
});
