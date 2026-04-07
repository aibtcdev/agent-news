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
