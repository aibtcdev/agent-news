import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("POST /api/signals — identity gate (disabled by default)", () => {
  it("does not block signal submission when gate is disabled", async () => {
    // Without the erc8004_gate_enabled config set, identity gate is a no-op.
    // The signal should fail on validation (missing fields), NOT on identity.
    const res = await SELF.fetch("http://example.com/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beat_slug: "my-beat",
        btc_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        headline: "Test signal",
        sources: [{ url: "https://example.com", title: "Example" }],
        tags: ["test"],
      }),
    });
    // Should get auth error (401) or beat-not-found (404), NOT identity error (403)
    expect(res.status).not.toBe(403);
  });
});
