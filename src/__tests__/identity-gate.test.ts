import { describe, it, expect, vi, afterEach } from "vitest";
import { checkAgentIdentity } from "../services/identity-gate";

/**
 * Unit tests for the identity gate service.
 *
 * These test the checkAgentIdentity function directly, since the full
 * POST /api/signals integration path requires a valid BIP-322 signature
 * which the test environment cannot easily generate.
 */

/**
 * Minimal KVNamespace mock. The real binding is a Cloudflare primitive;
 * this stub is sufficient for unit tests that don't run inside a worker pool.
 */
function makeKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [], list_complete: true, cursor: "" };
    },
    async getWithMetadata(key: string) {
      return { value: store.get(key) ?? null, metadata: null };
    },
  } as unknown as KVNamespace;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkAgentIdentity — cache hit", () => {
  it("returns cached result without fetching when cache is populated", async () => {
    const cached = JSON.stringify({ registered: true, level: 3, levelName: "Pioneer", apiReachable: true });
    const kv = makeKV({ "agent-level:bc1qtest": cached });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await checkAgentIdentity(kv, "bc1qtest");

    expect(result).toEqual({ registered: true, level: 3, levelName: "Pioneer", apiReachable: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns cached Level 1 result and does not call API", async () => {
    const cached = JSON.stringify({ registered: true, level: 1, levelName: "Member", apiReachable: true });
    const kv = makeKV({ "agent-level:bc1qlevel1": cached });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await checkAgentIdentity(kv, "bc1qlevel1");

    expect(result.level).toBe(1);
    expect(result.registered).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("checkAgentIdentity — API success", () => {
  it("returns registered=true and level=2 for a Genesis agent", async () => {
    const kv = makeKV();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ found: true, level: 2, levelName: "Genesis" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await checkAgentIdentity(kv, "bc1qgenesis");

    expect(result.registered).toBe(true);
    expect(result.level).toBe(2);
    expect(result.levelName).toBe("Genesis");
    expect(result.apiReachable).toBe(true);
  });

  it("caches the result after a successful API call", async () => {
    const kv = makeKV();
    const firstSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ found: true, level: 2, levelName: "Genesis" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await checkAgentIdentity(kv, "bc1qcachetest");
    expect(firstSpy).toHaveBeenCalledOnce();

    // Restore the first spy before creating a new one — stacking vi.spyOn causes double-counting
    firstSpy.mockRestore();

    // Second call should hit cache (fetch not called again)
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await checkAgentIdentity(kv, "bc1qcachetest");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns registered=false and level=null when found=false", async () => {
    const kv = makeKV();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ found: false }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await checkAgentIdentity(kv, "bc1qunregistered");

    expect(result.registered).toBe(false);
    expect(result.level).toBeNull();
  });
});

describe("checkAgentIdentity — fail open on API errors", () => {
  it("returns level=null (fail open) on network error", async () => {
    const kv = makeKV();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network failure"));

    const result = await checkAgentIdentity(kv, "bc1qnetworkerror");

    // Fail open: apiReachable=false, so the gate should not block the agent
    expect(result.level).toBeNull();
    expect(result.registered).toBe(false);
    expect(result.apiReachable).toBe(false);
  });

  it("returns level=null (fail open) on non-OK API response", async () => {
    const kv = makeKV();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Service Unavailable", { status: 503 })
    );

    const result = await checkAgentIdentity(kv, "bc1qserviceerror");

    expect(result.level).toBeNull();
    expect(result.apiReachable).toBe(false);
  });

  it("does not cache the result on API failure", async () => {
    const kv = makeKV();
    const firstSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("timeout"));

    await checkAgentIdentity(kv, "bc1qnocache");

    // Restore the first spy before creating a new one — stacking vi.spyOn causes double-counting
    firstSpy.mockRestore();

    // Second call should hit the API again (not cached)
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ found: true, level: 2, levelName: "Genesis" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const result = await checkAgentIdentity(kv, "bc1qnocache");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.level).toBe(2);
  });
});

describe("identity gate logic — level thresholds", () => {
  it("gate allows when apiReachable is false (fail open on API error)", () => {
    // Replicates the gate condition from signals.ts:
    // if (identity.apiReachable && (!identity.registered || identity.level === null || identity.level < 2))
    const identity = { registered: false, level: null, levelName: null, apiReachable: false };
    const shouldBlock =
      identity.apiReachable && (!identity.registered || identity.level === null || identity.level < 2);
    // apiReachable=false → gate fails open, never blocks regardless of registered/level
    expect(shouldBlock).toBe(false);
  });

  it("gate blocks a Level 1 agent", () => {
    const identity = { registered: true, level: 1, levelName: "Member", apiReachable: true };
    const shouldBlock =
      identity.apiReachable && (!identity.registered || identity.level === null || identity.level < 2);
    expect(shouldBlock).toBe(true);
  });

  it("gate allows a Level 2 (Genesis) agent", () => {
    const identity = { registered: true, level: 2, levelName: "Genesis", apiReachable: true };
    const shouldBlock =
      identity.apiReachable && (!identity.registered || identity.level === null || identity.level < 2);
    expect(shouldBlock).toBe(false);
  });

  it("gate allows a Level 3+ agent", () => {
    const identity = { registered: true, level: 3, levelName: "Pioneer", apiReachable: true };
    const shouldBlock =
      identity.apiReachable && (!identity.registered || identity.level === null || identity.level < 2);
    expect(shouldBlock).toBe(false);
  });

  it("gate blocks a registered agent with null level (missing level field)", () => {
    const identity = { registered: true, level: null as number | null, levelName: null, apiReachable: true };
    const shouldBlock =
      identity.apiReachable && (!identity.registered || identity.level === null || identity.level < 2);
    // registered=true but level=null → blocks (prevents bypass when API returns found:true with no level)
    expect(shouldBlock).toBe(true);
  });

  it("gate blocks an unregistered address when API is reachable", () => {
    const identity = { registered: false, level: null, levelName: null, apiReachable: true };
    const shouldBlock =
      identity.apiReachable && (!identity.registered || identity.level === null || identity.level < 2);
    expect(shouldBlock).toBe(true);
  });
});
