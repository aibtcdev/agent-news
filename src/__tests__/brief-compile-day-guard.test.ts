import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { getUTCDate, getUTCYesterday } from "../lib/helpers";

const COMPILER_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

/**
 * A brief is compiled once and never recompiled, so anything filed after the
 * compile is orphaned permanently — it can never reach its own day's brief and
 * no later brief covers it. Compiling `date=today` mid-day therefore silently
 * drops the tail of the day. Every brief from 2026-06-24 to 2026-07-14 was
 * compiled this way, losing 19-93% of each day's filings.
 *
 * The default (no `date`) has to be safe too: "call it the obvious way" was
 * exactly how the bug was introduced.
 */
async function compile(body: Record<string, unknown>) {
  return SELF.fetch("http://example.com/api/test/brief/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ btc_address: COMPILER_ADDRESS, ...body }),
  });
}

async function seed(body: Record<string, unknown>) {
  const res = await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

describe("brief compile — refuses a UTC day that has not ended", () => {
  it("rejects an explicit date of today", async () => {
    const today = getUTCDate();
    const res = await compile({ date: today });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toContain("has not ended yet");
    expect(body.error).toContain(today);
    // The hint must name the date to use, or it just blocks without helping.
    expect(body.hint).toContain(getUTCYesterday());
  });

  it("rejects a future date", async () => {
    const future = "2099-01-01";
    const res = await compile({ date: future });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("has not ended yet");
  });

  it("defaults to yesterday, not today — the call that caused the regression", async () => {
    // Seed yesterday only, then compile with no `date`. The old default
    // targeted today, found nothing there, and died on MIN_SIGNALS; the new
    // default targets yesterday and compiles it. Asserting the *resulting
    // brief date* is what makes this catch the regression — asserting only
    // "didn't hit the day guard" passes under both defaults and proves nothing.
    const yesterday = getUTCYesterday();
    await seed({
      signals: [1, 2, 3].map((n) => ({
        id: `default-target-${n}`,
        beat_slug: ["aibtc-network", "bitcoin-macro", "quantum"][n - 1],
        btc_address: COMPILER_ADDRESS,
        headline: `Default-target signal ${n}`,
        sources: "[]",
        created_at: `${yesterday}T1${n}:00:00Z`,
        status: "approved",
        reviewed_at: `${yesterday}T1${n}:30:00Z`,
      })),
    });

    const res = await compile({});
    expect(res.status).toBe(201);
    const body = (await res.json()) as { date: string };
    expect(body.date).toBe(yesterday);
    expect(body.date).not.toBe(getUTCDate());
  });

  it("allows a completed past date through the guard", async () => {
    // Reaches the compile path proper; with no seeded signals it stops at
    // MIN_SIGNALS. Asserting it is NOT the day-guard rejection.
    const res = await compile({ date: "2026-01-15" });
    const body = (await res.json()) as { error?: string };

    expect(body.error ?? "").not.toContain("has not ended yet");
  });

  it("still validates date format before the day guard", async () => {
    const res = await compile({ date: "15-01-2026" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid date format");
  });
});
