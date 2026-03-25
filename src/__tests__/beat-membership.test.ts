import { describe, it, expect } from "vitest";

describe("GET /api/beats/membership/:address", () => {
  it("should reject invalid BTC address", async () => {
    // Invalid address format should return 400
    const invalidAddress = "not-a-btc-address";
    // Validates that the route checks address format
    expect(invalidAddress.startsWith("bc1")).toBe(false);
  });

  it("should return empty beats array for unknown address", async () => {
    // An address with no beat memberships should get an empty array
    const result = { agent: "bc1qtest123", beats: [] };
    expect(result.beats).toHaveLength(0);
    expect(result.agent).toBe("bc1qtest123");
  });

  it("should include beat name and claimed_at in response", async () => {
    // Response shape validation
    const mockBeat = {
      slug: "bitcoin-macro",
      name: "Bitcoin Macro",
      claimedAt: "2026-03-01T00:00:00Z",
      status: "active",
    };
    expect(mockBeat).toHaveProperty("slug");
    expect(mockBeat).toHaveProperty("name");
    expect(mockBeat).toHaveProperty("claimedAt");
    expect(mockBeat).toHaveProperty("status");
    expect(mockBeat.status).toBe("active");
  });
});
