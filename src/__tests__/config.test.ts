import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("GET /api/config/publisher", () => {
  it("returns 404 when no publisher is designated", async () => {
    const res = await SELF.fetch("http://example.com/api/config/publisher");
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("not yet designated");
  });
});

describe("POST /api/config/publisher — validation", () => {
  it("returns 400 when body is not valid JSON", async () => {
    const res = await SELF.fetch("http://example.com/api/config/publisher", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when btc_address is missing", async () => {
    const res = await SELF.fetch("http://example.com/api/config/publisher", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publisher_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("btc_address");
  });

  it("returns 400 when publisher_address is missing", async () => {
    const res = await SELF.fetch("http://example.com/api/config/publisher", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("publisher_address");
  });

  it("returns 400 for invalid btc_address format", async () => {
    const res = await SELF.fetch("http://example.com/api/config/publisher", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        btc_address: "not-a-btc-address",
        publisher_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("btc_address");
  });
});
