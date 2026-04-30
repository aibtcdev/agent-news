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

describe("checkAgentIdentity — fail closed on API errors", () => {
  it("returns shouldBlock=true on network error after retry", async () => {
    const kv = makeKV();
    // Both attempts (initial + retry) reject — must fail closed
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network failure"))
      .mockRejectedValueOnce(new Error("network failure"));

    const result = await checkAgentIdentity(kv, "bc1qnetworkerror");

    // Fail closed: caller (signals.ts) reads shouldBlock and returns 503
    expect(result.shouldBlock).toBe(true);
    expect(result.apiReachable).toBe(false);
    expect(result.registered).toBe(false);
    expect(result.level).toBeNull();
  });

  it("returns shouldBlock=true on persistent 5xx", async () => {
    const kv = makeKV();
    // Both attempts return 503 — must fail closed
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }));

    const result = await checkAgentIdentity(kv, "bc1qserviceerror");

    expect(result.shouldBlock).toBe(true);
    expect(result.apiReachable).toBe(false);
    expect(result.level).toBeNull();
  });

  it("retries once on transient error then succeeds (does not fail closed)", async () => {
    const kv = makeKV();
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("transient timeout"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ found: true, level: 2, levelName: "Genesis" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const result = await checkAgentIdentity(kv, "bc1qretrysuccess");

    // Retry recovered — request proceeds normally, no block
    expect(result.shouldBlock).toBe(false);
    expect(result.apiReachable).toBe(true);
    expect(result.registered).toBe(true);
    expect(result.level).toBe(2);
  });

  it("does not cache the result on API failure", async () => {
    const kv = makeKV();
    // Both attempts fail — fail-closed result must NOT be cached
    const firstSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"));

    await checkAgentIdentity(kv, "bc1qnocache");

    // Restore the first spy before creating a new one — stacking vi.spyOn causes double-counting
    firstSpy.mockRestore();

    // Second call should hit the API again (not cached) and recover
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
    expect(result.shouldBlock).toBe(false);
  });
});

describe("identity gate logic — shouldBlock signal", () => {
  // signals.ts uses `if (identity.shouldBlock)` directly. The IdentityCheckResult
  // returned by checkAgentIdentity already encodes whether to block — these tests
  // assert the values produced for each scenario match the gate's contract.

  it("blocks when API is unreachable (fail closed)", async () => {
    const kv = makeKV();
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network failure"))
      .mockRejectedValueOnce(new Error("network failure"));

    const result = await checkAgentIdentity(kv, "bc1qfailclosed");
    expect(result.shouldBlock).toBe(true);
  });

  it("does not block a Level 2 (Genesis) agent", async () => {
    const kv = makeKV();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ found: true, level: 2, levelName: "Genesis" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await checkAgentIdentity(kv, "bc1qgenesis");
    expect(result.shouldBlock).toBe(false);
  });

  it("does not block on cache hit with prior allow", async () => {
    const cached = JSON.stringify({
      registered: true,
      level: 3,
      levelName: "Pioneer",
      apiReachable: true,
      shouldBlock: false,
    });
    const kv = makeKV({ "agent-level:bc1qpioneer": cached });

    const result = await checkAgentIdentity(kv, "bc1qpioneer");
    expect(result.shouldBlock).toBe(false);
  });

  it("does not block on cache hit recording an unregistered address (404 cached)", async () => {
    // Note: the gate consumer (signals.ts) layers a level-check on top of
    // shouldBlock for unregistered/low-level rejection (returns 401/403).
    // shouldBlock itself is reserved for the API-unreachable fail-closed case.
    const cached = JSON.stringify({
      registered: false,
      level: null,
      levelName: null,
      apiReachable: true,
      shouldBlock: false,
    });
    const kv = makeKV({ "agent-level:bc1q404": cached });

    const result = await checkAgentIdentity(kv, "bc1q404");
    expect(result.shouldBlock).toBe(false);
    // Caller is responsible for the level-check rejection on registered=false.
  });
});
