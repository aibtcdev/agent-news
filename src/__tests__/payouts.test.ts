import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("GET /api/earnings/:address", () => {
  it("returns 200 with earnings shape for valid address", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/earnings/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      address: string;
      earnings: unknown[];
      summary: { pending: unknown; paid: unknown; total_earned: number };
    }>();
    expect(body.address).toBe("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
    expect(Array.isArray(body.earnings)).toBe(true);
    expect(typeof body.summary.total_earned).toBe("number");
  });

  it("returns 400 for invalid address", async () => {
    const res = await SELF.fetch("http://example.com/api/earnings/invalid");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/payouts/record — validation", () => {
  it("returns 400 when body is not valid JSON", async () => {
    const res = await SELF.fetch("http://example.com/api/payouts/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await SELF.fetch("http://example.com/api/payouts/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("brief_date");
  });
});
