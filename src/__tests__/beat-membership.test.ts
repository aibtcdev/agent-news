import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("GET /api/beats/membership/:address", () => {
  it("should reject invalid BTC address with 400", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/beats/membership/not-a-btc-address"
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("Invalid BTC address");
  });

  it("should return empty beats array for unknown address", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/beats/membership/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ agent: string; beats: unknown[] }>();
    expect(body.agent).toBe(
      "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
    );
    expect(body.beats).toBeInstanceOf(Array);
  });

  it("should set cache headers on success", async () => {
    const res = await SELF.fetch(
      "http://example.com/api/beats/membership/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
    );
    expect(res.status).toBe(200);
    const cacheControl = res.headers.get("Cache-Control");
    expect(cacheControl).toContain("max-age=60");
    expect(cacheControl).toContain("s-maxage=300");
  });
});
