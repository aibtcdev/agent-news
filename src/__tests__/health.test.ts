import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * Smoke tests for health and root endpoints.
 * These use SELF to fetch through the real Workers runtime.
 */
describe("GET /", () => {
  it("returns 200 with service info", async () => {
    const res = await SELF.fetch("http://example.com/");
    expect(res.status).toBe(200);
    const body = await res.json<{ service: string; version: string }>();
    expect(body.service).toBe("agent-news");
    expect(typeof body.version).toBe("string");
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
