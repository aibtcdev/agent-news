import { describe, it, expect } from "vitest";
import { getLatestBrief, getBriefByDate } from "../lib/do-client";
import type { Env } from "../lib/types";

/**
 * A DO read failure and "no brief exists" are different answers. Before this
 * suite's fix, both collapsed to `null`, so `/api/brief` reported an
 * unreachable DO as an authoritative `{compiledAt: null}` with HTTP 200 —
 * telling callers today's brief was never compiled while it sat in storage.
 *
 * These build a fake NEWS_DO whose stub returns a chosen response, which is
 * enough to drive every branch: `getStub` only needs `idFromName` + `get`.
 */
function envReturning(response: () => Promise<Response>): Env {
  const stub = { fetch: response } as unknown as DurableObjectStub;
  return {
    NEWS_DO: {
      idFromName: () => "fake-id",
      get: () => stub,
    },
  } as unknown as Env;
}

const json = (body: unknown, status: number) => async () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const BRIEF = { date: "2026-07-15", text: "brief body", compiled_at: "2026-07-15T15:00:00Z" };

describe("getLatestBrief — null means absent, never unreachable", () => {
  it("returns the brief when the DO answers", async () => {
    const env = envReturning(json({ ok: true, data: BRIEF }, 200));
    await expect(getLatestBrief(env)).resolves.toMatchObject({ date: "2026-07-15" });
  });

  it("returns null when the DO reports 404 — its genuine 'no brief' signal", async () => {
    const env = envReturning(json({ ok: false, error: "No briefs compiled yet" }, 404));
    await expect(getLatestBrief(env)).resolves.toBeNull();
  });

  it("throws on a 503 instead of reporting the brief as absent", async () => {
    const env = envReturning(json({ ok: false, error: "overloaded" }, 503));
    await expect(getLatestBrief(env)).rejects.toThrow(/overloaded/);
  });

  it("throws when the DO fetch rejects — the DO_TIMEOUT path", async () => {
    const env = envReturning(() => Promise.reject(new Error("DO_TIMEOUT")));
    await expect(getLatestBrief(env)).rejects.toThrow(/timed out/i);
  });

  it("throws on a non-JSON 502 from CF infrastructure", async () => {
    const env = envReturning(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(getLatestBrief(env)).rejects.toThrow(/502/);
  });
});

describe("getBriefByDate — same contract", () => {
  it("returns the brief when the DO answers", async () => {
    const env = envReturning(json({ ok: true, data: BRIEF }, 200));
    await expect(getBriefByDate(env, "2026-07-15")).resolves.toMatchObject({ date: "2026-07-15" });
  });

  it("returns null when the DO reports 404", async () => {
    const env = envReturning(json({ ok: false, error: "No brief found for 2026-07-15" }, 404));
    await expect(getBriefByDate(env, "2026-07-15")).resolves.toBeNull();
  });

  it("throws on a 503 — a timeout must not surface as a 404 to the inscribe path", async () => {
    const env = envReturning(json({ ok: false, error: "overloaded" }, 503));
    await expect(getBriefByDate(env, "2026-07-15")).rejects.toThrow(/overloaded/);
  });

  it("throws when the DO fetch rejects", async () => {
    const env = envReturning(() => Promise.reject(new Error("DO_TIMEOUT")));
    await expect(getBriefByDate(env, "2026-07-15")).rejects.toThrow(/timed out/i);
  });
});
