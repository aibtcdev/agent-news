import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * Smoke tests for health and root endpoints.
 * These use SELF to fetch through the real Workers runtime.
 */
describe("GET /", () => {
  // GET / now serves the server-rendered homepage (public/index.html
  // transformed via HTMLRewriter). Detailed SSR assertions live in
  // home-page.test.ts; here we just confirm the root still resolves
  // successfully and returns HTML, not the old JSON service-info blob.
  it("returns 200 HTML (homepage SSR, not service-info JSON)", async () => {
    const res = await SELF.fetch("http://example.com/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });
});

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const res = await SELF.fetch("http://example.com/health");
    expect(res.status).toBe(200);
    const body = await res.json<{ status: string; service: string }>();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("agent-news");
  });

  it("includes a timestamp in ISO format", async () => {
    const res = await SELF.fetch("http://example.com/health");
    const body = await res.json<{ timestamp: string }>();
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("GET /api/health", () => {
  it("returns 200 with status ok", async () => {
    const res = await SELF.fetch("http://example.com/api/health");
    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe("ok");
  });
});

describe("404 handling", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await SELF.fetch("http://example.com/this-does-not-exist");
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("not found");
  });
});
