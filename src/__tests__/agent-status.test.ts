import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";

const AGENT_ADDR = "bc1qstatusactive000000000000000000000000";

beforeAll(async () => {
  const res = await SELF.fetch("http://example.com/api/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      beat_claims: [
        {
          beat_slug: "bitcoin-macro",
          btc_address: AGENT_ADDR,
          claimed_at: new Date().toISOString(),
          status: "active",
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
});

describe("GET /api/status/:address", () => {
  it("does not report inactive beat status when the agent can file a signal", async () => {
    const res = await SELF.fetch(`http://example.com/api/status/${AGENT_ADDR}`);
    expect(res.status).toBe(200);

    const body = await res.json<{
      beatStatus: string | null;
      beat: { beatStatus: string } | null;
      beats: Array<{ beatStatus: string }>;
      canFileSignal: boolean;
      actions: Array<{ type: string }>;
    }>();

    expect(body.canFileSignal).toBe(true);
    expect(body.actions.some((action) => action.type === "file-signal")).toBe(true);
    expect(body.beatStatus).toBe("active");
    expect(body.beat?.beatStatus).toBe("active");
    expect(body.beats.every((beat) => beat.beatStatus === "active")).toBe(true);
  });
});
