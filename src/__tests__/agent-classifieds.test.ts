import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";

const BTC_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

async function seed(body: Record<string, unknown>) {
  const res = await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  // Seed three approved, active classifieds — the middleware needs at least
  // one to inject anything.
  const future = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  await seed({
    classifieds: [
      {
        id: "ad-test-1",
        btc_address: BTC_ADDR,
        category: "services",
        headline: "Test Ad One",
        body: "First ad",
        created_at: new Date().toISOString(),
        expires_at: future,
        status: "approved",
      },
      {
        id: "ad-test-2",
        btc_address: BTC_ADDR,
        category: "agents",
        headline: "Test Ad Two",
        body: "Second ad",
        created_at: new Date().toISOString(),
        expires_at: future,
        status: "approved",
      },
      {
        id: "ad-test-3",
        btc_address: BTC_ADDR,
        category: "wanted",
        headline: "Test Ad Three",
        body: "Third ad",
        created_at: new Date().toISOString(),
        expires_at: future,
        status: "approved",
      },
    ],
  });
});

describe("agent classifieds injection", () => {
  it("attaches classifieds to /api/correspondents for agent (no Sec-Fetch-Site) requests", async () => {
    // Sanity: confirm seed worked before testing the middleware
    const sanity = await SELF.fetch("http://example.com/api/classifieds");
    const sanityBody = await sanity.json<{ classifieds: unknown[] }>();
    expect(sanityBody.classifieds.length).toBeGreaterThan(0);

    const res = await SELF.fetch("http://example.com/api/correspondents");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-classifieds-injected")).toBe("1");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json<{ classifieds?: unknown[] }>();
    expect(Array.isArray(body.classifieds)).toBe(true);
    expect(body.classifieds!.length).toBeGreaterThan(0);
    expect(body.classifieds!.length).toBeLessThanOrEqual(3);
  });

  it("does not attach classifieds when Sec-Fetch-Site is present (browser)", async () => {
    const res = await SELF.fetch("http://example.com/api/correspondents", {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-classifieds-injected")).toBeNull();
    const body = await res.json<{ classifieds?: unknown[] }>();
    expect(body.classifieds).toBeUndefined();
  });

  it("skips array-rooted endpoints to avoid breaking shape compatibility", async () => {
    // /api/beats returns a JSON array — middleware must not inject onto it.
    const res = await SELF.fetch("http://example.com/api/beats");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-classifieds-injected")).toBeNull();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("does not run on endpoints outside the configured list", async () => {
    // /api/health is intentionally excluded — agents that probe health
    // shouldn't get ads in their healthcheck payload.
    const res = await SELF.fetch("http://example.com/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-classifieds-injected")).toBeNull();
    const body = await res.json<{ classifieds?: unknown[] }>();
    expect(body.classifieds).toBeUndefined();
  });
});
