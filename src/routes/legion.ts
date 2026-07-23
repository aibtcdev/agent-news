/**
 * Legion governance routes.
 *
 *   POST /api/legion/chainhook — inbound Chainhooks webhook (event ingest)
 *   GET  /api/legion/state     — merged chain + indexed state for the UI
 *
 * Split of responsibility between the two:
 *
 *   The webhook carries everything that *happened* — contributions, proposals,
 *   votes, vetoes, conclusions. Each is a transaction, so each emits an event.
 *
 *   The state endpoint additionally reads `get-phase`, because a week crosses
 *   from voting into its veto window, and from there into concludable, purely
 *   because blocks passed. No transaction, no event, nothing to push. Reading
 *   that per request is why there is no cron in this design.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../lib/types";
import { edgeCacheMatch, edgeCachePut, edgeCacheDelete } from "../lib/edge-cache";
import {
  LEGION_GOV_CONTRACT,
  LEGION_NETWORK,
  TESTNET_BLOCK_SECONDS,
} from "../lib/legion-constants";
import {
  getTipHeight,
  getBrief,
  getBriefMeta,
  getPhase,
  getParams,
  getPoolStats,
  blocksRemaining,
  nextBoundaryHeight,
  predictOutcome,
} from "../services/legion-chain";
import { decodeClarityHex, toJSON } from "../lib/clarity";
import type { LegionEventRow } from "../objects/legion-do";

const legionRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const DO_ID_NAME = "legion-singleton";

function getLegionStub(env: Env): DurableObjectStub {
  const id = env.LEGION_DO.idFromName(DO_ID_NAME);
  return env.LEGION_DO.get(id);
}

// ── Webhook auth ──

/**
 * Chainhooks 2.0 has no per-hook `authorization_header` field — the action
 * schema is exactly `{type, url}`. Authentication is an account-wide consumer
 * secret instead, and the delivery-side header carrying it is not described in
 * the SDK types.
 *
 * So this accepts the secret from any of the plausible carriers, including a
 * query token, since the destination URL is the one part of the hook we fully
 * control. It fails closed: an unrecognised request is rejected and the header
 * *names* (never values) are logged, so the real carrier can be pinned from
 * the first live delivery and this list narrowed to one.
 */
const SECRET_HEADERS = [
  "x-chainhook-secret",
  "x-consumer-secret",
  "x-hiro-signature",
  "authorization",
];

/** Constant-time compare so a rejected probe cannot be timed to leak the secret. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAuthorised(request: Request, secret: string): boolean {
  for (const name of SECRET_HEADERS) {
    const raw = request.headers.get(name);
    if (!raw) continue;
    const value = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
    if (safeEqual(value, secret)) return true;
  }
  const token = new URL(request.url).searchParams.get("t");
  return token ? safeEqual(token, secret) : false;
}

// ── Payload normalisation ──

/**
 * Chainhooks 2.0 delivery payload.
 *
 * Shape taken from `@stacks/chainhooks-client`'s own TypeBox schemas, not from
 * the docs. It differs from classic Chainhook in several ways that all fail
 * silently — a parser written against the old shape finds zero events and
 * returns 200, so deliveries look healthy while nothing is indexed:
 *
 *   apply/rollback are under `event`, not top-level
 *   per-tx events are `operations`, not `metadata.receipt.events`
 *   the print type is `contract_log`, not `SmartContractEvent`
 *   fields hang off `metadata`, not `data`
 *   failure is `metadata.status !== "success"`, not `metadata.success === false`
 */
interface ChainhookOccurrence {
  chainhook?: { uuid?: string; name?: string };
  event?: {
    apply?: ChainhookBlock[];
    rollback?: ChainhookBlock[];
  };
}

interface ChainhookBlock {
  block_identifier?: { index?: number };
  timestamp?: number;
  metadata?: { burn_block_timestamp?: number };
  transactions?: ChainhookTransaction[];
}

interface ChainhookTransaction {
  transaction_identifier?: { hash?: string };
  operations?: ChainhookOperation[];
  metadata?: { status?: string };
}

interface ChainhookOperation {
  type?: string;
  operation_identifier?: { index?: number };
  metadata?: {
    contract_identifier?: string;
    topic?: string;
    /** Decoded object, or {hex, repr}, or a bare hex string. All three occur. */
    value?: unknown;
  };
}

/**
 * Normalise a print event's `value` into a plain object.
 *
 * `decode_clarity_values` is requested at registration, but the payload can
 * still carry `{hex, repr}` or a bare hex string depending on the path a
 * delivery takes. Rather than depend on that flag, fall back to decoding the
 * hex locally — the codec is already here and tested against real chain bytes,
 * so this works whether or not the service decoded it for us.
 */
function normaliseEventValue(value: unknown): Record<string, unknown> | null {
  if (!value) return null;

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Already decoded — a print tuple always carries an `event` discriminator.
    if (typeof obj.event === "string") return obj;
    if (typeof obj.hex === "string") return decodeHexTuple(obj.hex);
    return null;
  }

  if (typeof value === "string" && value.startsWith("0x")) {
    return decodeHexTuple(value);
  }
  return null;
}

function decodeHexTuple(hex: string): Record<string, unknown> | null {
  try {
    const decoded = toJSON(decodeClarityHex(hex));
    return decoded && typeof decoded === "object"
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    // A tuple we cannot decode is not worth failing the whole delivery over —
    // the other events in the batch are still good.
    return null;
  }
}

/**
 * Flatten a chainhook payload into rows.
 *
 * Only `contract_log` operations from the governance contract are kept, and
 * only from successful transactions — an aborted `conclude` must never render
 * as a conclusion that happened.
 */
export function extractEvents(blocks: ChainhookBlock[], contractId: string): LegionEventRow[] {
  const out: LegionEventRow[] = [];

  for (const block of blocks) {
    const height = block.block_identifier?.index;
    if (typeof height !== "number") continue;
    const blockTime = block.metadata?.burn_block_timestamp ?? block.timestamp ?? null;

    for (const tx of block.transactions ?? []) {
      if (tx.metadata?.status && tx.metadata.status !== "success") continue;
      const txid = tx.transaction_identifier?.hash;
      if (!txid) continue;

      (tx.operations ?? []).forEach((op, i) => {
        if (op.type !== "contract_log") return;
        if (op.metadata?.contract_identifier !== contractId) return;

        const data = normaliseEventValue(op.metadata?.value);
        const name = data && typeof data.event === "string" ? data.event : null;
        if (!data || !name) return;

        out.push({
          txid,
          event_index: op.operation_identifier?.index ?? i,
          contract_id: contractId,
          block_height: height,
          block_time: blockTime,
          event: name,
          brief_date: typeof data.briefDate === "string" ? data.briefDate : null,
          actor: null, // normalised inside the DO from who/proposer/voter
          data,
        });
      });
    }
  }

  return out;
}

function rollbackTxids(blocks: ChainhookBlock[]): string[] {
  const ids: string[] = [];
  for (const block of blocks) {
    for (const tx of block.transactions ?? []) {
      const hash = tx.transaction_identifier?.hash;
      if (hash) ids.push(hash);
    }
  }
  return ids;
}

// ── POST /api/legion/chainhook ──

legionRouter.post("/api/legion/chainhook", async (c) => {
  const logger = c.get("logger");
  const secret = c.env.CHAINHOOK_CONSUMER_SECRET;

  // No secret configured means the endpoint cannot authenticate anything.
  // Refuse rather than accept unauthenticated writes to the event store.
  if (!secret) {
    logger?.error?.("[legion] CHAINHOOK_CONSUMER_SECRET is not set; rejecting webhook");
    return c.json({ error: "Webhook not configured" }, 503);
  }

  if (!isAuthorised(c.req.raw, secret)) {
    logger?.warn?.("[legion] unauthorised chainhook delivery", {
      // Names only — never values, which would log the secret on a near-miss.
      headers: [...c.req.raw.headers.keys()].join(","),
    });
    return c.json({ error: "Unauthorized" }, 401);
  }

  let payload: ChainhookOccurrence;
  try {
    payload = await c.req.json<ChainhookOccurrence>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const applied = extractEvents(payload.event?.apply ?? [], LEGION_GOV_CONTRACT);
  const rolled = rollbackTxids(payload.event?.rollback ?? []);

  const stub = getLegionStub(c.env);
  let inserted = 0;
  let removed = 0;

  try {
    if (rolled.length > 0) {
      const res = await stub.fetch("https://legion/rollback", {
        method: "POST",
        body: JSON.stringify({ txids: rolled }),
      });
      removed = ((await res.json()) as { removed: number }).removed;
    }
    if (applied.length > 0) {
      const res = await stub.fetch("https://legion/record", {
        method: "POST",
        body: JSON.stringify({ events: applied }),
      });
      inserted = ((await res.json()) as { inserted: number }).inserted;
    }
  } catch (err) {
    // Return 500 so Chainhooks retries rather than dropping the delivery.
    // recordEvents is idempotent by (txid, event_index), so a redelivery of a
    // partially-applied batch cannot duplicate rows.
    logger?.error?.("[legion] failed to persist chainhook payload", { err: String(err) });
    return c.json({ error: "Failed to persist events" }, 500);
  }

  // Only purge when something actually changed. A redelivery that inserts
  // nothing should not evict a warm cache entry.
  if (inserted > 0 || removed > 0) {
    edgeCacheDelete(c, ["/api/legion/state"]);
  }

  if (applied.length === 0 && rolled.length === 0) {
    // Silent no-op deliveries are how a payload-shape mismatch hides: the
    // service records a healthy 200 while nothing is ever indexed.
    logger?.warn?.("[legion] chainhook delivery parsed to zero events", {
      blocks: payload.event?.apply?.length ?? 0,
      uuid: payload.chainhook?.uuid ?? "unknown",
    });
  }

  logger?.info?.("[legion] chainhook processed", {
    applied: applied.length,
    inserted,
    removed,
  });

  return c.json({ ok: true, inserted, removed, received: applied.length });
});

// ── GET /api/legion/state ──

legionRouter.get("/api/legion/state", async (c) => {
  const cached = await edgeCacheMatch(c);
  if (cached) return cached;

  const logger = c.get("logger");
  const apiKey = c.env.HIRO_API_KEY;
  const opts = apiKey ? { apiKey } : {};

  try {
    const stub = getLegionStub(c.env);
    const indexed = await stub
      .fetch(
        `https://legion/events?contract_id=${encodeURIComponent(LEGION_GOV_CONTRACT)}&limit=50`
      )
      .then(
        (r) =>
          r.json() as Promise<{
            events: LegionEventRow[];
            latest_brief_date: string | null;
            watermark: number | null;
          }>
      );

    // Which week to show comes from the chain, not the calendar — a brief can
    // be proposed late, and readers care about the newest proposed week rather
    // than whichever week today happens to fall in.
    const briefDate = c.req.query("week") ?? indexed.latest_brief_date;

    const [tipHeight, params, pool, brief, meta, phase] = await Promise.all([
      getTipHeight(opts),
      getParams(opts),
      getPoolStats(opts),
      briefDate ? getBrief(briefDate, opts) : Promise.resolve(null),
      briefDate ? getBriefMeta(briefDate, opts) : Promise.resolve(null),
      briefDate ? getPhase(briefDate, opts) : Promise.resolve("none" as const),
    ]);

    // Predicted only while the outcome is still undecided. Once the contract
    // has written a terminal status, `reason` is the truth and a prediction
    // alongside it would just invite disagreement.
    const prediction =
      brief && (phase === "voting" || phase === "veto" || phase === "concludable" || phase === "lapsed")
        ? predictOutcome(brief, params, pool.treasuryBalance, phase === "lapsed")
        : null;

    const payload = {
      network: LEGION_NETWORK,
      contract: LEGION_GOV_CONTRACT,
      tip_height: tipHeight,
      block_seconds: TESTNET_BLOCK_SECONDS,
      phase,
      blocks_remaining: blocksRemaining(
        brief, phase, tipHeight, params.vetoWindow, params.concludeWindow
      ),
      next_boundary_height: nextBoundaryHeight(
        brief, phase, params.vetoWindow, params.concludeWindow
      ),
      brief: brief
        ? {
            brief_date: brief.briefDate,
            title: meta?.title ?? "",
            description: meta?.description ?? "",
            status: brief.status,
            reason: brief.reason,
            created_at_height: brief.createdAt,
            vote_end: brief.voteEnd,
            veto_end: brief.voteEnd + params.vetoWindow,
            conclude_end: brief.voteEnd + params.vetoWindow + params.concludeWindow,
            // Fixed at propose time — concluding later pays exactly this.
            draw: brief.draw,
            yes_weight: brief.yesWeight,
            no_weight: brief.noWeight,
            veto_weight: brief.vetoWeight,
            voter_count: brief.voterCount,
            entry_count: brief.entryCount,
            total_signals: brief.totalSignals,
            bond: brief.bond,
            eligible_snapshot: brief.eligibleSnapshot,
          }
        : null,
      prediction,
      pool: {
        total_weight: pool.totalWeight,
        treasury_balance: pool.treasuryBalance,
        quote_draw: pool.quoteDraw,
        next_propose_height: pool.nextProposeHeight,
      },
      // Straight from get-params, so the UI can never quote a threshold the
      // contract no longer enforces.
      rules: params,
      events: indexed.events,
      indexed_through: indexed.watermark,
    };

    // Short TTL, and the webhook purges on write — so a new event shows up
    // immediately rather than waiting out the TTL. The TTL only bounds how
    // stale the *height-derived* phase can get, which nothing can purge
    // because no event fires when a window elapses.
    c.header("Cache-Control", "public, max-age=5, s-maxage=10");
    const response = c.json(payload);
    edgeCachePut(c, response);
    return response;
  } catch (err) {
    logger?.error?.("[legion] failed to build state", { err: String(err) });
    return c.json({ error: "Failed to read chain state" }, 502);
  }
});

export { legionRouter };
