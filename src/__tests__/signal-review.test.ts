import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("PATCH /api/signals/:id/review — validation", () => {
  it("returns 400 when body is not valid JSON", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/review",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when btc_address is missing", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/review",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("btc_address");
  });

  it("returns 400 when status is missing", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/review",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("status");
  });

  it("returns 400 for invalid status value", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/review",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
          status: "invalid-status",
        }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("Invalid status");
  });

  it("returns 400 for invalid btc_address format", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals/test-id/review",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          btc_address: "not-valid",
          status: "approved",
        }),
      }
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("BTC address");
  });
});

describe("GET /api/front-page", () => {
  it("returns 200 with curated signal list shape", async () => {
    const res = await SELF.fetch("http://example.com/api/front-page");
    expect(res.status).toBe(200);
    const body = await res.json<{
      signals: unknown[];
      total: number;
      curated: boolean;
    }>();
    expect(Array.isArray(body.signals)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(body.curated).toBe(true);
  });
});

describe("GET /api/signals — status filter", () => {
  it("accepts status query parameter without error", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals?status=approved"
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ signals: unknown[] }>();
    expect(Array.isArray(body.signals)).toBe(true);
  });

  it("returns empty list for status with no matching signals", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/signals?status=brief_included"
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ signals: unknown[]; total: number }>();
    expect(body.signals).toHaveLength(0);
  });
});
