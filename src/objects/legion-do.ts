/**
 * LegionDO — chain event store for the Legion governance UI.
 *
 * Separate from NewsDO on purpose. Its write path is inbound chainhook
 * webhooks on an unpredictable schedule and its read path backs a live page;
 * folding either into the news singleton would add traffic to the DO that
 * already dominates rows-read cost, and would couple a testnet-only feature to
 * a DO that needs a manual redeploy to cycle onto new code.
 *
 * Storage is a Durable Object rather than KV because the requirement is
 * "visible immediately". KV is eventually consistent with propagation up to a
 * minute, so a webhook could commit and the page still serve the old value
 * well after. A DO read observes the write the moment it lands.
 */

import { LEGION_SCHEMA_SQL } from "./legion-schema";

/** One decoded print event from news-gov. */
export interface LegionEventRow {
  txid: string;
  event_index: number;
  contract_id: string;
  block_height: number;
  block_time: number | null;
  event: string;
  brief_date: string | null;
  actor: string | null;
  data: Record<string, unknown>;
}

// Index signature required by SqlStorage's row generic, which constrains to
// Record<string, SqlStorageValue>.
interface StoredRow extends Record<string, SqlStorageValue> {
  txid: string;
  event_index: number;
  contract_id: string;
  block_height: number;
  block_time: number | null;
  event: string;
  brief_date: string | null;
  actor: string | null;
  payload: string;
}

/**
 * Principal fields differ per event type — the chainhook payload names the
 * actor `who` on a contribution, `proposer` on a proposal, `voter` on a vote.
 * Normalising at write time keeps the read path from re-deriving it per row.
 */
const ACTOR_KEYS = ["who", "proposer", "voter", "sender"] as const;

function extractActor(data: Record<string, unknown>): string | null {
  for (const key of ACTOR_KEYS) {
    const v = data[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function extractBriefDate(data: Record<string, unknown>): string | null {
  const v = data.briefDate;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export class LegionDO implements DurableObject {
  private readonly sql: SqlStorage;

  constructor(private readonly ctx: DurableObjectState) {
    this.sql = ctx.storage.sql;
    // Schema is idempotent; running it per construction keeps a cold-started
    // DO correct without a separate migration step.
    this.sql.exec(LEGION_SCHEMA_SQL);
  }

  /**
   * Upsert decoded events.
   *
   * Idempotent by (txid, event_index) so a chainhook redelivery — which the
   * service will do on any non-2xx, and which also happens on replay — cannot
   * duplicate a row. Returns how many rows were in the batch.
   *
   * Deliberately does NOT read to distinguish inserts from updates. An earlier
   * version ran a COUNT(*) per event to skip a cache purge on a pure
   * redelivery — a per-event read on the write path to optimise a rare case,
   * exactly the kind of unnecessary rows_read the cost runbook warns against.
   * ON CONFLICT DO UPDATE gives idempotency without it; a redelivery just costs
   * one cache rebuild, which is edge-cached anyway.
   */
  recordEvents(events: LegionEventRow[]): { total: number } {
    if (events.length === 0) return { total: 0 };

    const now = Date.now();

    // One transaction: a partial apply would leave the feed showing a vote
    // whose proposal is missing, which reads as data loss rather than lag.
    this.ctx.storage.transactionSync(() => {
      for (const e of events) {
        this.sql.exec(
          `INSERT INTO legion_events
             (txid, event_index, contract_id, block_height, block_time,
              event, brief_date, actor, payload, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(txid, event_index) DO UPDATE SET
             block_height = excluded.block_height,
             block_time   = excluded.block_time,
             payload      = excluded.payload`,
          e.txid,
          e.event_index,
          e.contract_id,
          e.block_height,
          e.block_time,
          e.event,
          e.brief_date ?? extractBriefDate(e.data),
          e.actor ?? extractActor(e.data),
          JSON.stringify(e.data),
          now
        );
      }
    });

    return { total: events.length };
  }

  /**
   * Drop events invalidated by a reorg.
   *
   * Chainhook delivers a `rollback` list alongside `apply`. Without handling
   * it a reorged vote stays on the page permanently, and the tallies rendered
   * from the feed drift from what the contract actually holds.
   */
  rollbackEvents(txids: string[]): number {
    if (txids.length === 0) return 0;

    let removed = 0;
    this.ctx.storage.transactionSync(() => {
      for (const txid of txids) {
        const cursor = this.sql.exec(
          "DELETE FROM legion_events WHERE txid = ?",
          txid
        );
        removed += cursor.rowsWritten;
      }
    });
    return removed;
  }

  /** Newest-first feed, optionally scoped to one week. */
  listEvents(opts: {
    contractId: string;
    briefDate?: string;
    limit?: number;
  }): LegionEventRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

    const rows = opts.briefDate
      ? this.sql
          .exec<StoredRow>(
            `SELECT * FROM legion_events
              WHERE contract_id = ? AND brief_date = ?
              ORDER BY block_height DESC, event_index DESC
              LIMIT ?`,
            opts.contractId,
            opts.briefDate,
            limit
          )
          .toArray()
      : this.sql
          .exec<StoredRow>(
            `SELECT * FROM legion_events
              WHERE contract_id = ?
              ORDER BY block_height DESC, event_index DESC
              LIMIT ?`,
            opts.contractId,
            limit
          )
          .toArray();

    return rows.map((r) => ({
      txid: r.txid,
      event_index: r.event_index,
      contract_id: r.contract_id,
      block_height: r.block_height,
      block_time: r.block_time,
      event: r.event,
      brief_date: r.brief_date,
      actor: r.actor,
      data: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  }

  /**
   * The most recent brief date seen on-chain.
   *
   * Used to decide which week the page should show without guessing from the
   * calendar — a week can be proposed late, and the newest *proposed* week is
   * what readers care about, not whichever week today falls in.
   */
  latestBriefDate(contractId: string): string | null {
    const row = this.sql
      .exec<{ brief_date: string | null }>(
        `SELECT brief_date FROM legion_events
          WHERE contract_id = ? AND brief_date IS NOT NULL
          ORDER BY block_height DESC, event_index DESC
          LIMIT 1`,
        contractId
      )
      .toArray()[0];
    return row?.brief_date ?? null;
  }

  /** Highest block indexed, so a backfill knows where to resume. */
  watermark(contractId: string): number | null {
    const row = this.sql
      .exec<{ h: number | null }>(
        "SELECT MAX(block_height) AS h FROM legion_events WHERE contract_id = ?",
        contractId
      )
      .toArray()[0];
    return row?.h ?? null;
  }


  /** Router for worker→DO calls. Kept minimal; the worker owns HTTP concerns. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case "/record": {
          const body = (await request.json()) as { events: LegionEventRow[] };
          return Response.json(this.recordEvents(body.events ?? []));
        }
        case "/rollback": {
          const body = (await request.json()) as { txids: string[] };
          return Response.json({ removed: this.rollbackEvents(body.txids ?? []) });
        }
        case "/events": {
          const contractId = url.searchParams.get("contract_id") ?? "";
          const briefDate = url.searchParams.get("brief_date") ?? undefined;
          const limit = Number(url.searchParams.get("limit") ?? 50);
          return Response.json({
            events: this.listEvents({ contractId, briefDate, limit }),
            latest_brief_date: this.latestBriefDate(contractId),
            watermark: this.watermark(contractId),
          });
        }
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  }
}
