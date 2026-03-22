/**
 * ERC-8004 on-chain identity service.
 *
 * Resolves a BTC address to an agent identity via the Clarity contract
 * `SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2`
 * using the Hiro `call-read-only` API endpoint.
 *
 * Clarity `string-ascii` CV wire format (used for the `btcAddress` argument):
 *   0x0d                   — type_id byte for string-ascii
 *   <4-byte big-endian len> — byte length of the ASCII string
 *   <ASCII bytes>          — the raw string bytes
 *
 * Without the 4-byte length prefix, the Hiro API rejects or misparsed the CV,
 * causing `resolve-identity` to return an error on every call.
 *
 * KV caching:
 *   - Positive (identity found):  1-hour TTL  — on-chain registrations are stable
 *   - Negative (not found / err): 15-minute TTL — re-checks sooner for agents
 *     that recently registered
 */

const HIRO_API_BASE = "https://api.hiro.so";
const IDENTITY_CONTRACT_ADDRESS = "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD";
const IDENTITY_CONTRACT_NAME = "identity-registry-v2";
const IDENTITY_FUNCTION_NAME = "resolve-identity";

const CACHE_TTL_POSITIVE_SECONDS = 3600;  // 1 hour
const CACHE_TTL_NEGATIVE_SECONDS = 900;   // 15 minutes
const CACHE_KEY_PREFIX = "erc8004:";

export interface ERC8004Identity {
  /** Whether the BTC address has an active ERC-8004 registration. */
  registered: boolean;
  /** The Stacks principal associated with the identity, if resolved. */
  stacksAddress: string | null;
  /** Whether the Hiro API was reachable (false = fail open). */
  apiReachable: boolean;
}

/**
 * Encode a BTC address string as a Clarity `string-ascii` CV.
 *
 * Wire format: type_id (0x0d) + 4-byte big-endian length + ASCII bytes.
 * The 4-byte length prefix is required by the Clarity CV serialization spec.
 * Omitting it causes the Hiro call-read-only API to reject or misparse the arg,
 * making every call return null/error regardless of on-chain state.
 */
function encodeStringAsciiCV(value: string): string {
  const bytes = Array.from(new TextEncoder().encode(value));
  const lenHex = bytes.length.toString(16).padStart(8, "0"); // 4-byte BE length
  const bodyHex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `0x0d${lenHex}${bodyHex}`;
}

/**
 * Call the `resolve-identity` read-only function on the identity registry contract.
 * Returns the raw Clarity response object, or null on any network/parse error.
 */
async function callResolveIdentity(
  btcAddress: string
): Promise<Record<string, unknown> | null> {
  const url = `${HIRO_API_BASE}/v2/contracts/call-read/${IDENTITY_CONTRACT_ADDRESS}/${IDENTITY_CONTRACT_NAME}/${IDENTITY_FUNCTION_NAME}`;
  const hexArg = encodeStringAsciiCV(btcAddress);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: IDENTITY_CONTRACT_ADDRESS,
      arguments: [hexArg],
    }),
  });

  if (!res.ok) return null;

  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Parse the Clarity response from `resolve-identity` into an ERC8004Identity.
 *
 * The contract returns `(ok (some {...}))` when found, `(ok none)` when not found,
 * or `(err ...)` on contract errors. We treat any non-some response as unregistered.
 */
function parseIdentityResponse(
  raw: Record<string, unknown>
): Pick<ERC8004Identity, "registered" | "stacksAddress"> {
  // Hiro returns: { okay: true, result: "<clarity hex>" }
  // We rely on the result field being a decoded CV object when using the JSON endpoint.
  const result = raw?.result as Record<string, unknown> | undefined;

  // `(ok (some { stacks-address: principal, ... }))` → registered
  const type = result?.type as string | undefined;
  if (type === "ok") {
    const value = result?.value as Record<string, unknown> | undefined;
    if (value?.type === "some") {
      const inner = value?.value as Record<string, unknown> | undefined;
      const stacksAddress =
        (inner?.["stacks-address"] as string | undefined) ?? null;
      return { registered: true, stacksAddress };
    }
  }

  return { registered: false, stacksAddress: null };
}

/**
 * Resolve the ERC-8004 identity for a BTC address.
 *
 * Uses KV caching to avoid per-request on-chain lookups:
 *   - 1h TTL for confirmed registrations (stable on-chain data)
 *   - 15m TTL for negative/error results (agents may register soon)
 *
 * Fails open on network errors: if the Hiro API is unreachable, returns
 * `apiReachable: false` and the caller should allow the request through.
 */
export async function resolveIdentity(
  kv: KVNamespace,
  btcAddress: string
): Promise<ERC8004Identity> {
  const cacheKey = `${CACHE_KEY_PREFIX}${btcAddress}`;

  // Check KV cache first
  const cached = await kv.get(cacheKey);
  if (cached !== null) {
    try {
      return JSON.parse(cached) as ERC8004Identity;
    } catch {
      // Malformed cache entry — fall through to live lookup
    }
  }

  // Live call to Hiro API
  let raw: Record<string, unknown> | null;
  try {
    raw = await callResolveIdentity(btcAddress);
  } catch {
    // Network error — fail open, do not cache
    return { registered: false, stacksAddress: null, apiReachable: false };
  }

  if (raw === null) {
    // API returned non-OK HTTP — fail open, do not cache
    return { registered: false, stacksAddress: null, apiReachable: false };
  }

  const { registered, stacksAddress } = parseIdentityResponse(raw);
  const identity: ERC8004Identity = { registered, stacksAddress, apiReachable: true };

  // Cache with TTL appropriate to the result
  const ttl = registered ? CACHE_TTL_POSITIVE_SECONDS : CACHE_TTL_NEGATIVE_SECONDS;
  await kv.put(cacheKey, JSON.stringify(identity), { expirationTtl: ttl });

  return identity;
}
