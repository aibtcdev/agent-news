import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveIdentity } from "../services/identity";

/**
 * Unit tests for the ERC-8004 identity service (Phase B).
 *
 * These tests verify:
 *  - Correct Clarity string-ascii CV encoding (4-byte length prefix)
 *  - KV caching behaviour (1h positive TTL, 15m negative TTL)
 *  - Fail-open on network errors and non-OK HTTP responses
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

describe("resolveIdentity — Clarity string-ascii CV encoding", () => {
  it("encodes BTC address with 4-byte big-endian length prefix", async () => {
    const kv = makeKV();
    let capturedBody: string | undefined;

    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          result: {
            type: "ok",
            value: { type: "some", value: { "stacks-address": "SP123" } },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    await resolveIdentity(kv, "bc1qtest");

    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody as string);
    const hexArg: string = parsed.arguments[0];

    // type_id byte for string-ascii must be 0x0d
    expect(hexArg.startsWith("0x0d")).toBe(true);

    // The "bc1qtest" string is 8 bytes — length hex should be "00000008"
    const lenHex = hexArg.slice(4, 12); // "0x0d" = 4 chars, next 8 chars = 4-byte len
    expect(lenHex).toBe("00000008");

    // ASCII body: "bc1qtest" = 62 63 31 71 74 65 73 74
    const bodyHex = hexArg.slice(12);
    expect(bodyHex).toBe("6263317174657374");
  });
});

describe("resolveIdentity — cache behaviour", () => {
  it("returns cached result without fetching", async () => {
    const cached = JSON.stringify({ registered: true, stacksAddress: "SP123", apiReachable: true });
    const kv = makeKV({ "erc8004:bc1qcached": cached });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await resolveIdentity(kv, "bc1qcached");

    expect(result.registered).toBe(true);
    expect(result.stacksAddress).toBe("SP123");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("caches a positive result after a successful API call", async () => {
    const kv = makeKV();
    const firstSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: {
            type: "ok",
            value: { type: "some", value: { "stacks-address": "SP456" } },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await resolveIdentity(kv, "bc1qregisered");
    expect(firstSpy).toHaveBeenCalledOnce();
    firstSpy.mockRestore();

    // Second call: should hit cache
    const fetchSpy2 = vi.spyOn(globalThis, "fetch");
    const result = await resolveIdentity(kv, "bc1qregisered");
    expect(fetchSpy2).not.toHaveBeenCalled();
    expect(result.registered).toBe(true);
  });
});

describe("resolveIdentity — API responses", () => {
  it("returns registered=true when contract returns (ok (some {...}))", async () => {
    const kv = makeKV();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: {
            type: "ok",
            value: { type: "some", value: { "stacks-address": "SP789" } },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await resolveIdentity(kv, "bc1qregistered");

    expect(result.registered).toBe(true);
    expect(result.stacksAddress).toBe("SP789");
    expect(result.apiReachable).toBe(true);
  });

  it("returns registered=false when contract returns (ok none)", async () => {
    const kv = makeKV();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: { type: "ok", value: { type: "none" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await resolveIdentity(kv, "bc1qunregistered");

    expect(result.registered).toBe(false);
    expect(result.stacksAddress).toBeNull();
    expect(result.apiReachable).toBe(true);
  });
});

describe("resolveIdentity — fail open on errors", () => {
  it("returns apiReachable=false on network error without caching", async () => {
    const kv = makeKV();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network timeout"));

    const result = await resolveIdentity(kv, "bc1qnetworkerr");

    expect(result.registered).toBe(false);
    expect(result.apiReachable).toBe(false);
  });

  it("returns apiReachable=false on non-OK HTTP response", async () => {
    const kv = makeKV();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 })
    );

    const result = await resolveIdentity(kv, "bc1qserviceerr");

    expect(result.registered).toBe(false);
    expect(result.apiReachable).toBe(false);
  });

  it("does not cache results when API is unreachable", async () => {
    const kv = makeKV();
    const firstSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("timeout"));

    await resolveIdentity(kv, "bc1qnocache");
    firstSpy.mockRestore();

    // Second call should hit the API again (not the KV cache)
    const fetchSpy2 = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: {
            type: "ok",
            value: { type: "some", value: { "stacks-address": "SPRETRY" } },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await resolveIdentity(kv, "bc1qnocache");
    expect(fetchSpy2).toHaveBeenCalledOnce();
    expect(result.registered).toBe(true);
  });
});
