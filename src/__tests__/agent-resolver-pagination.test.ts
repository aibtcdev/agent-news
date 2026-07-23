import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveAgentNames } from "../services/agent-resolver";

/**
 * Regression tests for the bulk agent-name fetch pagination (issue #320).
 *
 * The bulk path previously stopped after a hardcoded 10 pages (1000 agents).
 * Once the aibtc.com registry passed that size, every agent beyond index 999
 * became permanently unresolvable in batch lookups and rendered on the agents
 * page as a truncated BTC address, even though the registry held a displayName
 * for them. The loop is now sized from `pagination.total`.
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

const PAGE_SIZE = 100;

/** Deterministic synthetic registry: agent N lives at index N. */
function addressAt(index: number): string {
  return `bc1qagent${String(index).padStart(6, "0")}`;
}

/**
 * Stubs the paginated `GET /api/agents` endpoint with a registry of `total`
 * agents. Returns the spy so tests can assert how many pages were requested.
 */
function stubRegistry(total: number) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? String(PAGE_SIZE));

    const agents = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) {
      agents.push({
        btcAddress: addressAt(i),
        displayName: `Agent ${i}`,
      });
    }

    return new Response(
      JSON.stringify({
        agents,
        pagination: { total, limit, offset, hasMore: offset + limit < total },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveAgentNames — registry larger than the old 1000-agent cap", () => {
  it("resolves an agent past index 999 (the #320 truncation boundary)", async () => {
    stubRegistry(1049);
    const kv = makeKV();

    // Index 1048 is the last agent in the registry — on page 10, the first
    // page the old `page < 10` loop never requested.
    const target = addressAt(1048);
    const result = await resolveAgentNames(kv, [target]);

    expect(result.get(target)?.name).toBe("Agent 1048");
  });

  it("resolves agents on both sides of the boundary in one call", async () => {
    stubRegistry(1049);
    const kv = makeKV();

    const early = addressAt(3); // page 0 — worked before the fix
    const late = addressAt(1002); // page 10 — did not
    const result = await resolveAgentNames(kv, [early, late]);

    expect(result.get(early)?.name).toBe("Agent 3");
    expect(result.get(late)?.name).toBe("Agent 1002");
  });

  it("positively caches a past-boundary name so the next call skips the fetch", async () => {
    const fetchSpy = stubRegistry(1049);
    const kv = makeKV();
    const target = addressAt(1040);

    await resolveAgentNames(kv, [target]);
    const callsAfterFirst = fetchSpy.mock.calls.length;

    const second = await resolveAgentNames(kv, [target]);

    expect(second.get(target)?.name).toBe("Agent 1040");
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it("stops at the real end of the registry rather than walking to the ceiling", async () => {
    const fetchSpy = stubRegistry(1049);
    const kv = makeKV();

    await resolveAgentNames(kv, [addressAt(1048)]);

    // 1049 agents / 100 per page = 11 pages (offsets 0..1000). Anything more
    // means the loop ignored `total`/`hasMore` and kept paging into the void.
    expect(fetchSpy.mock.calls.length).toBe(11);
  });

  it("still negative-caches a genuinely absent address once the full registry is read", async () => {
    const fetchSpy = stubRegistry(1049);
    const kv = makeKV();
    const absent = "bc1qnotregisteredanywhere";

    const first = await resolveAgentNames(kv, [absent]);
    expect(first.get(absent)?.name).toBeNull();

    const callsAfterFirst = fetchSpy.mock.calls.length;
    const second = await resolveAgentNames(kv, [absent]);

    expect(second.get(absent)?.name).toBeNull();
    // The negative cache must be written — otherwise every rebuild re-runs the
    // full multi-page registry pull, which is the cost #867 set out to remove.
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it("does not negative-cache when the registry fetch is incomplete", async () => {
    // Page 0 succeeds and advertises more, page 1 fails: the fetch is partial,
    // so an unmatched address must not be recorded as "no such agent".
    let call = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        call++;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              agents: [{ btcAddress: addressAt(0), displayName: "Agent 0" }],
              pagination: { total: 500, limit: PAGE_SIZE, offset: 0, hasMore: true },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("upstream down", { status: 503 });
      });

    const kv = makeKV();
    const absent = addressAt(400);

    await resolveAgentNames(kv, [absent]);
    const callsAfterFirst = fetchSpy.mock.calls.length;

    await resolveAgentNames(kv, [absent]);

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
