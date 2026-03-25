import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, Beat, Signal, SignalStatus, Streak, Brief, Classified, ClassifiedStatus, Earning, Correction, ReferralCredit, BriefSignal, CompiledBriefData, DOResult, PayoutRecord } from "../lib/types";
import { validateSlug, validateHexColor, sanitizeString } from "../lib/validators";
import { generateId, getPacificDate, getPacificYesterday, getPacificDayStartUTC, getNextDate } from "../lib/helpers";
import { CLASSIFIED_DURATION_DAYS, CLASSIFIED_BRIEF_SLOTS, CLASSIFIED_BRIEF_MAX_CHARS, CLASSIFIED_STATUSES, SIGNAL_COOLDOWN_HOURS, BEAT_EXPIRY_DAYS, MAX_SIGNALS_PER_DAY, SIGNAL_STATUSES, CONFIG_PUBLISHER_ADDRESS, BRIEF_INCLUSION_PAYOUT_SATS, WEEKLY_PRIZE_1ST_SATS, WEEKLY_PRIZE_2ND_SATS, WEEKLY_PRIZE_3RD_SATS, SCORING_WEIGHTS } from "../lib/constants";
import { SCHEMA_SQL, MIGRATION_PHASE0_SQL, MIGRATION_PAYMENTS_SQL, MIGRATION_BEAT_RESTRUCTURE_SQL, MIGRATION_SBTC_TRACKING_SQL, MIGRATION_CLASSIFIEDS_CLEANUP_SQL, MIGRATION_CLASSIFIEDS_REVIEW_SQL, MIGRATION_SNAPSHOTS_SQL, MIGRATION_BEAT_CLAIMS_SQL, MIGRATION_RETRACTION_SQL } from "./schema";

// ── State machine transition maps ──
// Hoisted to module level so they are created once and are testable.

/** Valid editorial transitions for signals: submitted → in_review → approved/rejected → brief_included */
export const SIGNAL_VALID_TRANSITIONS: Record<SignalStatus, SignalStatus[]> = {
  submitted: ["in_review", "approved", "rejected"],
  in_review: ["approved", "rejected"],
  approved: ["brief_included", "rejected"],
  rejected: ["approved"],
  brief_included: ["rejected"],
};

/** Valid editorial transitions for classifieds: pending_review → approved/rejected */
export const CLASSIFIED_VALID_TRANSITIONS: Record<ClassifiedStatus, ClassifiedStatus[]> = {
  pending_review: ["approved", "rejected"],
  rejected: ["approved"],
  approved: [], // terminal — TTL is already running
};

/**
 * Raw SQL row returned by signal SELECT queries.
 * All scalar columns come back as strings or null from SQLite.
 * tags_csv is produced by GROUP_CONCAT in join queries.
 */
interface RawSignalRow {
  id: string;
  beat_slug: string;
  beat_name: string | null;
  btc_address: string;
  headline: string;
  body: string | null;
  sources: string; // JSON-encoded Source[]
  created_at: string;
  updated_at: string;
  correction_of: string | null;
  tags_csv: string | null;
  status: SignalStatus;
  publisher_feedback: string | null;
  reviewed_at: string | null;
  disclosure: string;
}

/**
 * Convert a raw SQL row (with tags_csv from GROUP_CONCAT) into a Signal object.
 * Casting via RawSignalRow gives TypeScript visibility into the row shape and
 * avoids the opaque `as unknown as Signal` double cast.
 */
function rowToSignal(row: Record<string, unknown>): Signal {
  const raw = row as unknown as RawSignalRow;
  return {
    id: raw.id,
    beat_slug: raw.beat_slug,
    beat_name: raw.beat_name ?? null,
    btc_address: raw.btc_address,
    headline: raw.headline,
    body: raw.body,
    sources: JSON.parse(raw.sources || "[]"),
    tags: raw.tags_csv ? raw.tags_csv.split(",") : [],
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    correction_of: raw.correction_of,
    status: raw.status ?? "submitted",
    publisher_feedback: raw.publisher_feedback ?? null,
    reviewed_at: raw.reviewed_at ?? null,
    disclosure: raw.disclosure ?? "",
  };
}

/**
 * Parse a required JSON body from a Hono context.
 * Returns the parsed object, or null if the body is missing or malformed.
 * Callers should return a 400 response when null is returned.
 */
async function parseRequiredJson<T = Record<string, unknown>>(
  c: Context
): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

/**
 * Verify that the given BTC address matches the designated Publisher.
 * Returns the publisher address on success, or an error string on failure.
 */
function verifyPublisher(
  sql: DurableObjectState["storage"]["sql"],
  btcAddress: string
): { ok: true; address: string } | { ok: false; error: string; status: 403 } {
  const rows = sql
    .exec("SELECT value FROM config WHERE key = ?", CONFIG_PUBLISHER_ADDRESS)
    .toArray();
  if (rows.length === 0) {
    return { ok: false, error: "Publisher not yet designated", status: 403 };
  }
  const publisherAddress = (rows[0] as { value: string }).value;
  if (btcAddress !== publisherAddress) {
    return { ok: false, error: "Only the designated Publisher can perform this action", status: 403 };
  }
  return { ok: true, address: publisherAddress };
}

/**
 * NewsDO — Durable Object with SQLite storage for agent-news.
 *
 * Uses this.ctx.storage.sql.exec() to initialize the schema on construction.
 * Internal routes are handled by a Hono router for clean dispatch.
 */
export class NewsDO extends DurableObject<Env> {
  private readonly router: Hono;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Initialize SQLite schema (idempotent via IF NOT EXISTS).
    // sql.exec() is synchronous in DO SQLite, so no blockConcurrencyWhile needed.
    this.ctx.storage.sql.exec(SCHEMA_SQL);

    // Track migration version in config table to skip already-applied migrations on cold start.
    // This avoids running 50+ SQL statements (ALTER TABLE, UPSERT, UPDATE, DELETE) every time
    // the DO wakes up, significantly reducing cold start latency.
    //
    // Migration version history:
    // 1 = Phase 0 (ALTER TABLE column additions: status, publisher_feedback, reviewed_at, disclosure)
    // 2 = Beat restructure (17-beat taxonomy upsert, signal remaps, old beat deletes)
    // 3 = Payments UNIQUE index (double-pay prevention on earnings)
    // 4 = sBTC tracking (payout_txid column on earnings)
    // 5 = Classifieds cleanup (drop contact column)
    // 6 = Classifieds editorial review (status, publisher_feedback, reviewed_at, refund_txid)
    // 7 = Leaderboard snapshots (audit infrastructure for prize competitions)
    // 8 = Beat claims (multi-agent beats — beat_claims join table)
    // 9 = Retraction support (retracted_at on brief_signals, voided_at on earnings)
    const CURRENT_MIGRATION_VERSION = 9;
    const versionRows = this.ctx.storage.sql
      .exec("SELECT value FROM config WHERE key = 'migration_version'")
      .toArray();
    let appliedVersion = 0;
    if (versionRows.length > 0) {
      const parsed = Number((versionRows[0] as { value: string }).value);
      appliedVersion = Number.isFinite(parsed) ? parsed : 0;
    }

    if (appliedVersion < CURRENT_MIGRATION_VERSION) {
      // Run Phase 0 migrations for existing databases (safe to re-run — ALTER TABLE
      // throws "duplicate column" which we catch and ignore).
      if (appliedVersion < 1) {
        for (const stmt of MIGRATION_PHASE0_SQL) {
          try {
            this.ctx.storage.sql.exec(stmt);
          } catch (e) {
            console.error("Migration statement failed (likely already applied):", e);
          }
        }
      }

      // Run Phase 3 beat-restructure migration as a single exec() call.
      if (appliedVersion < 2) {
        try {
          this.ctx.storage.sql.exec(MIGRATION_BEAT_RESTRUCTURE_SQL);
        } catch (e) {
          console.error("Beat restructure migration failed:", e);
        }
      }

      // Run Phase 4 payments migration — adds UNIQUE index for double-pay prevention.
      if (appliedVersion < 3) {
        for (const stmt of MIGRATION_PAYMENTS_SQL) {
          try {
            this.ctx.storage.sql.exec(stmt);
          } catch (e) {
            console.error("Payments migration statement failed (likely already applied):", e);
          }
        }
      }

      // Run sBTC tracking migration — adds payout_txid column to earnings.
      if (appliedVersion < 4) {
        for (const stmt of MIGRATION_SBTC_TRACKING_SQL) {
          try {
            this.ctx.storage.sql.exec(stmt);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!msg.includes("duplicate column")) {
              console.error("sBTC tracking migration statement failed:", e);
            }
          }
        }
      }

      // Run classifieds cleanup migration — drops contact column.
      if (appliedVersion < 5) {
        for (const stmt of MIGRATION_CLASSIFIEDS_CLEANUP_SQL) {
          try {
            this.ctx.storage.sql.exec(stmt);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!msg.includes("no such column") && !msg.includes("no column")) {
              console.error("Classifieds cleanup migration statement failed:", e);
            }
          }
        }
      }

      // Run classifieds editorial review migration.
      if (appliedVersion < 6) {
        for (const stmt of MIGRATION_CLASSIFIEDS_REVIEW_SQL) {
          try {
            this.ctx.storage.sql.exec(stmt);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!msg.includes("duplicate column")) {
              console.error("Classifieds review migration statement failed:", e);
            }
          }
        }
      }

      // Run leaderboard snapshots migration — audit infrastructure for prize competitions.
      if (appliedVersion < 7) {
        for (const stmt of MIGRATION_SNAPSHOTS_SQL) {
          try {
            this.ctx.storage.sql.exec(stmt);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!msg.includes("already exists")) {
              console.error("Snapshots migration statement failed:", e);
            }
          }
        }
      }

      // Run beat claims migration — multi-agent beats join table.
      if (appliedVersion < 8) {
        for (const stmt of MIGRATION_BEAT_CLAIMS_SQL) {
          try {
            this.ctx.storage.sql.exec(stmt);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!msg.includes("already exists")) {
              console.error("Beat claims migration statement failed:", e);
            }
          }
        }
      }

      // Run retraction support migration — soft-archive columns for brief_signals and earnings.
      if (appliedVersion < 9) {
        for (const stmt of MIGRATION_RETRACTION_SQL) {
          try {
            this.ctx.storage.sql.exec(stmt);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!msg.includes("duplicate column")) {
              console.error("Retraction migration statement failed:", e);
            }
          }
        }
      }

      // Record current migration version so future cold starts skip all of the above.
      this.ctx.storage.sql.exec(
        "INSERT INTO config (key, value) VALUES ('migration_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        String(CURRENT_MIGRATION_VERSION)
      );
    }

    // Schedule a keep-alive alarm if none exists. The alarm fires every 50 seconds,
    // preventing the DO from being evicted after 70-140 seconds of inactivity.
    // This eliminates cold start overhead for the singleton DO that serves all traffic.
    this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null) {
        await this.ctx.storage.setAlarm(Date.now() + 50_000);
      }
    });

    // Internal Hono router for DO-internal routing
    this.router = new Hono();

    this.router.get("/health", (c) => {
      return c.json({ ok: true, migrated: true });
    });

    // -------------------------------------------------------------------------
    // Config (key-value store for publisher designation, etc.)
    // -------------------------------------------------------------------------

    // GET /config/:key — get a config value
    this.router.get("/config/:key", (c) => {
      const key = c.req.param("key");
      const rows = this.ctx.storage.sql
        .exec("SELECT value, updated_at FROM config WHERE key = ?", key)
        .toArray();
      if (rows.length === 0) {
        return c.json({ ok: false, error: `Config key "${key}" not set` } satisfies DOResult<unknown>, 404);
      }
      const row = rows[0] as { value: string; updated_at: string };
      return c.json({ ok: true, data: { key, value: row.value, updated_at: row.updated_at } } satisfies DOResult<unknown>);
    });

    // PUT /config/:key — set a config value
    this.router.put("/config/:key", async (c) => {
      const key = c.req.param("key");
      const body = await parseRequiredJson(c);
      if (!body || !body.value) {
        return c.json({ ok: false, error: "Missing required field: value" } satisfies DOResult<unknown>, 400);
      }
      const now = new Date().toISOString();
      this.ctx.storage.sql.exec(
        `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        body.value as string,
        now
      );
      return c.json({ ok: true, data: { key, value: body.value, updated_at: now } } satisfies DOResult<unknown>);
    });

    // -------------------------------------------------------------------------
    // Signal Review (Publisher-only editorial actions)
    // -------------------------------------------------------------------------

    // PATCH /signals/:id/review — Publisher sets status + optional feedback
    this.router.patch("/signals/:id/review", async (c) => {
      const id = c.req.param("id");
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json({ ok: false, error: "Invalid JSON body" } satisfies DOResult<Signal>, 400);
      }

      const { btc_address, status, feedback } = body;

      // Verify publisher designation
      const publisherRows = this.ctx.storage.sql
        .exec("SELECT value FROM config WHERE key = ?", CONFIG_PUBLISHER_ADDRESS)
        .toArray();
      if (publisherRows.length === 0) {
        return c.json({ ok: false, error: "Publisher not yet designated" } satisfies DOResult<Signal>, 403);
      }
      const publisherAddress = (publisherRows[0] as { value: string }).value;
      if (btc_address !== publisherAddress) {
        return c.json({ ok: false, error: "Only the designated Publisher can perform this action" } satisfies DOResult<Signal>, 403);
      }

      // Validate status
      if (!status || !(SIGNAL_STATUSES as readonly string[]).includes(status as string)) {
        return c.json({
          ok: false,
          error: `Invalid status. Must be one of: ${SIGNAL_STATUSES.join(", ")}`,
        } satisfies DOResult<Signal>, 400);
      }

      // Rejection requires feedback
      if (status === "rejected" && !feedback) {
        return c.json({ ok: false, error: "Feedback is required when rejecting a signal" } satisfies DOResult<Signal>, 400);
      }

      // Verify signal exists and enforce state transition rules
      const signalRows = this.ctx.storage.sql
        .exec("SELECT id, status FROM signals WHERE id = ?", id)
        .toArray();
      if (signalRows.length === 0) {
        return c.json({ ok: false, error: `Signal "${id}" not found` } satisfies DOResult<Signal>, 404);
      }

      // State machine: prevent editorial regressions
      const currentStatus = (signalRows[0] as { id: string; status: SignalStatus }).status;
      const newStatus = status as SignalStatus; // validated above against SIGNAL_STATUSES
      const allowed = SIGNAL_VALID_TRANSITIONS[currentStatus] ?? [];
      if (!allowed.includes(newStatus)) {
        return c.json({
          ok: false,
          error: `Invalid transition: "${currentStatus}" → "${newStatus}". Allowed from ${currentStatus}: ${allowed.length ? allowed.join(", ") : "none (terminal state)"}`,
        } satisfies DOResult<Signal>, 400);
      }

      // Pre-inscription retraction gate: brief_included → rejected is only allowed
      // if the brief containing this signal has NOT been inscribed yet.
      // Post-inscription, the on-chain record is final — use additive corrections instead.
      if (currentStatus === "brief_included" && newStatus === "rejected") {
        const inscriptionRows = this.ctx.storage.sql
          .exec(
            `SELECT b.inscription_id
             FROM brief_signals bs
             JOIN briefs b ON bs.brief_date = b.date
             WHERE bs.signal_id = ?
             LIMIT 1`,
            id
          )
          .toArray();
        if (inscriptionRows.length > 0 && (inscriptionRows[0] as Record<string, unknown>).inscription_id) {
          return c.json({
            ok: false,
            error: "Cannot retract a signal after its brief has been inscribed. Use a correction instead.",
          } satisfies DOResult<Signal>, 409);
        }
      }

      const now = new Date().toISOString();
      this.ctx.storage.sql.exec(
        `UPDATE signals SET status = ?, publisher_feedback = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ?`,
        newStatus,
        feedback ? sanitizeString(feedback, 1000) : null,
        now,
        now,
        id
      );

      // Soft-archive brief_signals and void unpaid earnings when retracting a brief_included signal.
      // Records are preserved for audit — retracted_at/voided_at timestamps mark them inactive.
      if (currentStatus === "brief_included" && newStatus === "rejected") {
        this.ctx.storage.sql.exec(
          "UPDATE brief_signals SET retracted_at = ? WHERE signal_id = ? AND retracted_at IS NULL",
          now, id
        );
        this.ctx.storage.sql.exec(
          "UPDATE earnings SET voided_at = ? WHERE reason = 'brief_inclusion' AND reference_id = ? AND payout_txid IS NULL AND voided_at IS NULL",
          now, id
        );
      }

      // Re-fetch with tags
      const updated = this.ctx.storage.sql
        .exec(
          `SELECT s.*, b.name as beat_name, GROUP_CONCAT(st.tag) as tags_csv
           FROM signals s
           LEFT JOIN beats b ON s.beat_slug = b.slug
           LEFT JOIN signal_tags st ON s.id = st.signal_id
           WHERE s.id = ?1
           GROUP BY s.id`,
          id
        )
        .toArray();

      const signal = rowToSignal(updated[0] as Record<string, unknown>);
      return c.json({ ok: true, data: signal } satisfies DOResult<Signal>);
    });

    // -------------------------------------------------------------------------
    // Beats CRUD
    // -------------------------------------------------------------------------

    // GET /beats — list all beats ordered by name, with computed status
    this.router.get("/beats", (c) => {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT b.*, MAX(s.created_at) as last_signal_at
           FROM beats b
           LEFT JOIN beat_claims bc ON b.slug = bc.beat_slug AND bc.status = 'active'
           LEFT JOIN signals s ON bc.btc_address = s.btc_address
             AND s.beat_slug = b.slug
             AND s.correction_of IS NULL
           GROUP BY b.slug
           ORDER BY b.name`
        )
        .toArray();

      // Fetch all active claims for member lists
      const claimRows = this.ctx.storage.sql
        .exec(
          `SELECT beat_slug, btc_address, claimed_at, status
           FROM beat_claims WHERE status = 'active'
           ORDER BY claimed_at`
        )
        .toArray();
      const claimsByBeat = new Map<string, Array<{ btc_address: string; claimed_at: string; status: string }>>();
      for (const cr of claimRows) {
        const claim = cr as Record<string, unknown>;
        const slug = claim.beat_slug as string;
        if (!claimsByBeat.has(slug)) claimsByBeat.set(slug, []);
        claimsByBeat.get(slug)!.push({
          btc_address: claim.btc_address as string,
          claimed_at: claim.claimed_at as string,
          status: claim.status as string,
        });
      }

      const expiryMs = BEAT_EXPIRY_DAYS * 24 * 3600 * 1000;
      const now = Date.now();
      const beats = rows.map((r) => {
        const row = r as Record<string, unknown>;
        const lastSignalAt = row.last_signal_at as string | null;
        const status: "active" | "inactive" =
          lastSignalAt && now - new Date(lastSignalAt).getTime() < expiryMs
            ? "active"
            : "inactive";
        return {
          slug: row.slug,
          name: row.name,
          description: row.description,
          color: row.color,
          created_by: row.created_by,
          created_at: row.created_at,
          updated_at: row.updated_at,
          status,
          members: claimsByBeat.get(row.slug as string) ?? [],
        } as Beat;
      });
      return c.json({ ok: true, data: beats } satisfies DOResult<Beat[]>);
    });

    // GET /beats/:slug — get a single beat by slug, with computed status
    this.router.get("/beats/:slug", (c) => {
      const slug = c.req.param("slug");
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT b.*, MAX(s.created_at) as last_signal_at
           FROM beats b
           LEFT JOIN beat_claims bc ON b.slug = bc.beat_slug AND bc.status = 'active'
           LEFT JOIN signals s ON bc.btc_address = s.btc_address
             AND s.beat_slug = b.slug
             AND s.correction_of IS NULL
           WHERE b.slug = ?
           GROUP BY b.slug`,
          slug
        )
        .toArray();
      if (rows.length === 0) {
        return c.json(
          { ok: false, error: `Beat "${slug}" not found` } satisfies DOResult<Beat>,
          404
        );
      }
      const row = rows[0] as Record<string, unknown>;
      const lastSignalAt = row.last_signal_at as string | null;
      const expiryMs = BEAT_EXPIRY_DAYS * 24 * 3600 * 1000;
      const status: "active" | "inactive" =
        lastSignalAt && Date.now() - new Date(lastSignalAt).getTime() < expiryMs
          ? "active"
          : "inactive";

      // Fetch members for this beat
      const memberRows = this.ctx.storage.sql
        .exec(
          `SELECT btc_address, claimed_at, status
           FROM beat_claims
           WHERE beat_slug = ? AND status = 'active'
           ORDER BY claimed_at`,
          slug
        )
        .toArray();

      const beat: Beat = {
        slug: row.slug as string,
        name: row.name as string,
        description: row.description as string | null,
        color: row.color as string | null,
        created_by: row.created_by as string,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
        status,
        members: memberRows.map((r) => {
          const mr = r as Record<string, unknown>;
          return {
            btc_address: mr.btc_address as string,
            claimed_at: mr.claimed_at as string,
            status: mr.status as "active" | "inactive",
          };
        }),
      };
      return c.json({ ok: true, data: beat } satisfies DOResult<Beat>);
    });

    // POST /beats — create a new beat
    this.router.post("/beats", async (c) => {
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json(
          { ok: false, error: "Invalid JSON body" } satisfies DOResult<Beat>,
          400
        );
      }

      const { slug, name, description, color, created_by } = body;

      if (!slug || !name || !created_by) {
        return c.json(
          {
            ok: false,
            error: "Missing required fields: slug, name, created_by",
          } satisfies DOResult<Beat>,
          400
        );
      }

      if (!validateSlug(slug)) {
        return c.json(
          {
            ok: false,
            error: "Invalid slug (a-z0-9 + hyphens, 3-50 chars)",
          } satisfies DOResult<Beat>,
          400
        );
      }

      if (color !== undefined && color !== null && !validateHexColor(color)) {
        return c.json(
          {
            ok: false,
            error: "Invalid color format (expected #RRGGBB)",
          } satisfies DOResult<Beat>,
          400
        );
      }

      // Check for existing beat — allow join if active, reclaim if inactive
      const existing = this.ctx.storage.sql
        .exec(
          `SELECT b.*, MAX(s.created_at) as last_signal_at
           FROM beats b
           LEFT JOIN beat_claims bc ON b.slug = bc.beat_slug AND bc.status = 'active'
           LEFT JOIN signals s ON bc.btc_address = s.btc_address
             AND s.beat_slug = b.slug
             AND s.correction_of IS NULL
           WHERE b.slug = ?
           GROUP BY b.slug`,
          slug as string
        )
        .toArray();
      if (existing.length > 0) {
        const row = existing[0] as Record<string, unknown>;
        const lastSignalAt = row.last_signal_at as string | null;
        const expiryMs = BEAT_EXPIRY_DAYS * 24 * 3600 * 1000;
        const isActive = lastSignalAt && Date.now() - new Date(lastSignalAt).getTime() < expiryMs;

        // Check if agent already has an active claim
        const existingClaim = this.ctx.storage.sql
          .exec(
            "SELECT 1 FROM beat_claims WHERE beat_slug = ? AND btc_address = ? AND status = 'active'",
            slug as string,
            created_by as string
          )
          .toArray();
        if (existingClaim.length > 0) {
          return c.json(
            {
              ok: false,
              error: `You are already a member of beat "${slug as string}"`,
            } satisfies DOResult<Beat>,
            409
          );
        }

        // Active or inactive — agent can join via beat_claims
        const now = new Date().toISOString();
        this.ctx.storage.sql.exec(
          `INSERT INTO beat_claims (beat_slug, btc_address, claimed_at, status)
           VALUES (?, ?, ?, 'active')
           ON CONFLICT(beat_slug, btc_address) DO UPDATE SET status = 'active', claimed_at = excluded.claimed_at`,
          slug as string,
          created_by as string,
          now
        );

        // If beat was inactive (no active members with recent signals), update updated_at
        if (!isActive) {
          this.ctx.storage.sql.exec(
            "UPDATE beats SET updated_at = ? WHERE slug = ?",
            now,
            slug as string
          );
        }

        const reclaimed = this.ctx.storage.sql
          .exec("SELECT * FROM beats WHERE slug = ?", slug as string)
          .toArray();
        const beat = reclaimed[0] as unknown as Beat;
        return c.json({ ok: true, data: { ...beat, status: isActive ? "active" as const : "inactive" as const } } satisfies DOResult<Beat>, 200);
      }

      // Only the Publisher can create new beats
      const pub = verifyPublisher(this.ctx.storage.sql, created_by as string);
      if (!pub.ok) {
        return c.json(
          { ok: false, error: pub.error } satisfies DOResult<Beat>,
          pub.status
        );
      }

      const now = new Date().toISOString();
      const beatSlug = slug as string;
      const beatName = sanitizeString(name, 100);
      const beatDescription = description
        ? sanitizeString(description, 500)
        : null;
      const beatColor = color ? (color as string) : null;
      const beatCreatedBy = created_by as string;

      this.ctx.storage.sql.exec(
        `INSERT INTO beats (slug, name, description, color, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        beatSlug,
        beatName,
        beatDescription,
        beatColor,
        beatCreatedBy,
        now,
        now
      );

      // Also create the initial beat_claims entry for the creator
      this.ctx.storage.sql.exec(
        `INSERT INTO beat_claims (beat_slug, btc_address, claimed_at, status)
         VALUES (?, ?, ?, 'active')`,
        beatSlug,
        beatCreatedBy,
        now
      );

      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM beats WHERE slug = ?", beatSlug)
        .toArray();
      const beat = rows[0] as unknown as Beat;

      return c.json({ ok: true, data: beat } satisfies DOResult<Beat>, 201);
    });

    // DELETE /beats/:slug — delete a beat (Publisher-only)
    this.router.delete("/beats/:slug", async (c) => {
      const slug = c.req.param("slug");

      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json(
          { ok: false, error: "Invalid JSON body" } satisfies DOResult<unknown>,
          400
        );
      }

      const { btc_address } = body;
      if (!btc_address) {
        return c.json(
          { ok: false, error: "Missing required field: btc_address" } satisfies DOResult<unknown>,
          400
        );
      }

      // Verify publisher
      const pub = verifyPublisher(this.ctx.storage.sql, btc_address as string);
      if (!pub.ok) {
        return c.json(
          { ok: false, error: pub.error } satisfies DOResult<unknown>,
          pub.status
        );
      }

      // Check beat exists
      const existing = this.ctx.storage.sql
        .exec("SELECT * FROM beats WHERE slug = ?", slug)
        .toArray();
      if (existing.length === 0) {
        return c.json(
          { ok: false, error: `Beat "${slug}" not found` } satisfies DOResult<unknown>,
          404
        );
      }

      // Count signals for the response
      const signalRows = this.ctx.storage.sql
        .exec("SELECT COUNT(*) as cnt FROM signals WHERE beat_slug = ?", slug)
        .toArray();
      const signalCount = (signalRows[0] as { cnt: number }).cnt;

      // Cascade delete in a transaction: dependents → signals → beat_claims → beat
      try {
        this.ctx.storage.sql.exec("BEGIN");
        if (signalCount > 0) {
          this.ctx.storage.sql.exec(
            "DELETE FROM signal_tags WHERE signal_id IN (SELECT id FROM signals WHERE beat_slug = ?)",
            slug
          );
          this.ctx.storage.sql.exec(
            "DELETE FROM brief_signals WHERE signal_id IN (SELECT id FROM signals WHERE beat_slug = ?)",
            slug
          );
          this.ctx.storage.sql.exec(
            "DELETE FROM corrections WHERE signal_id IN (SELECT id FROM signals WHERE beat_slug = ?)",
            slug
          );
          this.ctx.storage.sql.exec("DELETE FROM signals WHERE beat_slug = ?", slug);
        }
        this.ctx.storage.sql.exec("DELETE FROM beat_claims WHERE beat_slug = ?", slug);
        this.ctx.storage.sql.exec("DELETE FROM beats WHERE slug = ?", slug);
        this.ctx.storage.sql.exec("COMMIT");
      } catch (e) {
        this.ctx.storage.sql.exec("ROLLBACK");
        return c.json(
          { ok: false, error: "Cascade delete failed" } satisfies DOResult<unknown>,
          500
        );
      }

      return c.json({ ok: true, data: { slug, deleted: true, signals_deleted: signalCount } });
    });

    // PATCH /beats/:slug — update a beat (only name, description, color)
    this.router.patch("/beats/:slug", async (c) => {
      const slug = c.req.param("slug");

      const existing = this.ctx.storage.sql
        .exec("SELECT * FROM beats WHERE slug = ?", slug)
        .toArray();
      if (existing.length === 0) {
        return c.json(
          { ok: false, error: `Beat "${slug}" not found` } satisfies DOResult<Beat>,
          404
        );
      }

      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json(
          { ok: false, error: "Invalid JSON body" } satisfies DOResult<Beat>,
          400
        );
      }

      // Build update fields dynamically (only update provided fields)
      const setClauses: string[] = [];
      const params: unknown[] = [];

      if (body.name !== undefined) {
        setClauses.push("name = ?");
        params.push(sanitizeString(body.name, 100));
      }

      if (body.description !== undefined) {
        setClauses.push("description = ?");
        params.push(
          body.description ? sanitizeString(body.description, 500) : null
        );
      }

      if (body.color !== undefined) {
        if (body.color !== null && !validateHexColor(body.color)) {
          return c.json(
            {
              ok: false,
              error: "Invalid color format (expected #RRGGBB)",
            } satisfies DOResult<Beat>,
            400
          );
        }
        setClauses.push("color = ?");
        params.push(body.color ?? null);
      }

      if (setClauses.length === 0) {
        return c.json(
          {
            ok: false,
            error: "No updatable fields provided (name, description, color)",
          } satisfies DOResult<Beat>,
          400
        );
      }

      const now = new Date().toISOString();
      setClauses.push("updated_at = ?");
      params.push(now);
      params.push(slug);

      this.ctx.storage.sql.exec(
        `UPDATE beats SET ${setClauses.join(", ")} WHERE slug = ?`,
        ...params
      );

      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM beats WHERE slug = ?", slug)
        .toArray();
      const beat = rows[0] as unknown as Beat;

      return c.json({ ok: true, data: beat } satisfies DOResult<Beat>);
    });

    // -------------------------------------------------------------------------
    // Signals CRUD
    // -------------------------------------------------------------------------

    // GET /signals/counts — signal counts grouped by status
    this.router.get("/signals/counts", (c) => {
      const rows = this.ctx.storage.sql
        .exec("SELECT status, COUNT(*) as count FROM signals GROUP BY status")
        .toArray();
      // Initialize with all known statuses set to 0 so the response shape
      // always includes every status key, even when no signals have that status.
      const counts: Record<string, number> = {};
      for (const s of SIGNAL_STATUSES) {
        counts[s] = 0;
      }
      for (const row of rows) {
        const r = row as { status: string; count: number };
        counts[r.status] = Number(r.count);
      }
      return c.json({ ok: true, data: counts } satisfies DOResult<Record<string, number>>);
    });

    // GET /signals — list signals with optional filters (beat, agent, tag, since, status, limit)
    this.router.get("/signals", (c) => {
      const beat = c.req.query("beat") ?? null;
      const agent = c.req.query("agent") ?? null;
      const since = c.req.query("since") ?? null;
      const tag = c.req.query("tag") ?? null;
      const status = c.req.query("status") ?? null;
      const limitParam = c.req.query("limit");
      const limit = Math.min(
        Math.max(1, parseInt(limitParam ?? "50", 10) || 50),
        200
      );

      const rows = this.ctx.storage.sql
        .exec(
          `SELECT s.*, b.name as beat_name, GROUP_CONCAT(st.tag) as tags_csv
           FROM signals s
           LEFT JOIN beats b ON s.beat_slug = b.slug
           LEFT JOIN signal_tags st ON s.id = st.signal_id
           WHERE (?1 IS NULL OR s.beat_slug = ?1)
             AND (?2 IS NULL OR s.btc_address = ?2)
             AND (?3 IS NULL OR s.created_at > ?3)
             AND (?4 IS NULL OR s.id IN (SELECT signal_id FROM signal_tags WHERE tag = ?4))
             AND (?5 IS NULL OR s.status = ?5)
           GROUP BY s.id
           ORDER BY s.created_at DESC
           LIMIT ?6`,
          beat,
          agent,
          since,
          tag,
          status,
          limit
        )
        .toArray();

      const signals = rows.map((r) => rowToSignal(r as Record<string, unknown>));

      return c.json({ ok: true, data: signals } satisfies DOResult<Signal[]>);
    });

    // GET /signals/front-page — all approved + brief_included signals in a single query
    // Eliminates the need for two separate /signals calls from the Worker route.
    // LIMIT 500 preserves the old behavior (200 approved + 200 brief_included = up to 400).
    this.router.get("/signals/front-page", (c) => {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT s.*, b.name as beat_name, GROUP_CONCAT(st.tag) as tags_csv
           FROM signals s
           LEFT JOIN beats b ON s.beat_slug = b.slug
           LEFT JOIN signal_tags st ON s.id = st.signal_id
           WHERE s.status IN ('approved', 'brief_included')
           GROUP BY s.id
           ORDER BY s.created_at DESC
           LIMIT 500`
        )
        .toArray();

      const signals = rows.map((r) => rowToSignal(r as Record<string, unknown>));
      return c.json({ ok: true, data: signals } satisfies DOResult<Signal[]>);
    });

    // GET /signals/front-page-page — date-paginated curated signals for infinite scroll
    // Query params: before (YYYY-MM-DD Pacific date, required), limit (unused, kept for compat)
    // Uses 2-step query: (1) find the target Pacific day, (2) fetch ALL signals for that day.
    // Returns signals from the most recent Pacific day strictly before `before`, with hasMore flag.
    this.router.get("/signals/front-page-page", (c) => {
      const before = c.req.query("before") ?? null;

      if (!before || !/^\d{4}-\d{2}-\d{2}$/.test(before)) {
        return c.json(
          { ok: false, error: "Missing or invalid 'before' param (YYYY-MM-DD required)" },
          400
        );
      }

      // Use Pacific-day boundaries to match brief date semantics
      const beforeDayStartUTC = getPacificDayStartUTC(before);

      // Step 1: Find the target day — get the most recent signal strictly before the boundary
      const probeRows = this.ctx.storage.sql
        .exec(
          `SELECT s.created_at
           FROM signals s
           WHERE s.status IN ('approved', 'brief_included')
             AND s.created_at < ?1
           ORDER BY s.created_at DESC
           LIMIT 1`,
          beforeDayStartUTC
        )
        .toArray();

      if (probeRows.length === 0) {
        return c.json({ ok: true, data: { signals: [], date: null, hasMore: false } });
      }

      // Determine the Pacific date of the most recent signal before the boundary
      const probeTimestamp = (probeRows[0] as Record<string, unknown>).created_at as string;
      const day = getPacificDate(new Date(probeTimestamp));
      const dayStartUTC = getPacificDayStartUTC(day);
      const dayEndUTC = getPacificDayStartUTC(getNextDate(day));

      // Step 2: Fetch ALL signals for that Pacific day (complete day, no limit)
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT s.*, b.name as beat_name, GROUP_CONCAT(st.tag) as tags_csv
           FROM signals s
           LEFT JOIN beats b ON s.beat_slug = b.slug
           LEFT JOIN signal_tags st ON s.id = st.signal_id
           WHERE s.status IN ('approved', 'brief_included')
             AND s.created_at >= ?1
             AND s.created_at < ?2
           GROUP BY s.id
           ORDER BY s.created_at DESC`,
          dayStartUTC,
          dayEndUTC
        )
        .toArray();

      const daySignals = rows.map((r) => rowToSignal(r as Record<string, unknown>));

      // Check hasMore: are there any signals before this day?
      const olderRows = this.ctx.storage.sql
        .exec(
          `SELECT 1 FROM signals
           WHERE status IN ('approved', 'brief_included')
             AND created_at < ?1
           LIMIT 1`,
          dayStartUTC
        )
        .toArray();
      const hasMore = olderRows.length > 0;

      return c.json({ ok: true, data: { signals: daySignals, date: day, hasMore } });
    });

    // GET /signals/counts — lightweight signal counts by status (no full records fetched)
    this.router.get("/signals/counts", (c) => {
      const beat = c.req.query("beat") ?? null;
      const agent = c.req.query("agent") ?? null;
      const sinceRaw = c.req.query("since") ?? null;
      const since = sinceRaw && sinceRaw.trim() !== "" ? sinceRaw : null;

      const rows = this.ctx.storage.sql
        .exec(
          `SELECT status, COUNT(*) as count
           FROM signals
           WHERE (?1 IS NULL OR beat_slug = ?1)
             AND (?2 IS NULL OR btc_address = ?2)
             AND (?3 IS NULL OR created_at >= ?3)
           GROUP BY status`,
          beat,
          agent,
          since
        )
        .toArray();

      const counts: Record<string, number> = {
        submitted: 0,
        in_review: 0,
        approved: 0,
        rejected: 0,
        brief_included: 0,
      };
      for (const row of rows) {
        const r = row as { status: string; count: number };
        if (r.status in counts) {
          counts[r.status] = r.count;
        }
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);

      return c.json({ ok: true, data: { ...counts, total } });
    });

    // GET /signals/:id — get a single signal with tags and beat name joined
    this.router.get("/signals/:id", (c) => {
      const id = c.req.param("id");
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT s.*, b.name as beat_name, GROUP_CONCAT(st.tag) as tags_csv
           FROM signals s
           LEFT JOIN beats b ON s.beat_slug = b.slug
           LEFT JOIN signal_tags st ON s.id = st.signal_id
           WHERE s.id = ?1
           GROUP BY s.id`,
          id
        )
        .toArray();

      if (rows.length === 0) {
        return c.json(
          { ok: false, error: `Signal "${id}" not found` } satisfies DOResult<Signal>,
          404
        );
      }

      const signal = rowToSignal(rows[0] as Record<string, unknown>);

      return c.json({ ok: true, data: signal } satisfies DOResult<Signal>);
    });

    // POST /signals — atomic insert: signal + tags + streak + earning
    this.router.post("/signals", async (c) => {
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json(
          { ok: false, error: "Invalid JSON body" } satisfies DOResult<Signal>,
          400
        );
      }

      const { beat_slug, btc_address, headline, body: signalBody, sources, tags } = body;

      // Validate beat exists
      const beatRows = this.ctx.storage.sql
        .exec("SELECT 1 FROM beats WHERE slug = ?", beat_slug as string)
        .toArray();
      if (beatRows.length === 0) {
        return c.json(
          { ok: false, error: `Beat "${beat_slug as string}" not found` } satisfies DOResult<Signal>,
          404
        );
      }

      // Verify agent is a member of this beat
      const claimRows = this.ctx.storage.sql
        .exec(
          "SELECT 1 FROM beat_claims WHERE beat_slug = ? AND btc_address = ? AND status = 'active'",
          beat_slug as string,
          btc_address as string
        )
        .toArray();
      if (claimRows.length === 0) {
        return c.json(
          { ok: false, error: `You must claim beat "${beat_slug as string}" before filing signals on it` } satisfies DOResult<Signal>,
          403
        );
      }

      // 4-hour global cooldown per agent (separate from IP rate limiting)
      const lastSignalRows = this.ctx.storage.sql
        .exec(
          `SELECT created_at FROM signals
           WHERE btc_address = ? AND correction_of IS NULL
           ORDER BY created_at DESC LIMIT 1`,
          btc_address as string
        )
        .toArray();
      if (lastSignalRows.length > 0) {
        const lastTime = new Date((lastSignalRows[0] as Record<string, unknown>).created_at as string).getTime();
        const cooldownMs = SIGNAL_COOLDOWN_HOURS * 3600 * 1000;
        const elapsed = Date.now() - lastTime;
        if (elapsed < cooldownMs) {
          const waitMinutes = Math.ceil((cooldownMs - elapsed) / 60000);
          return c.json(
            {
              ok: false,
              error: `Cooldown active — please wait ${waitMinutes} minute${waitMinutes === 1 ? "" : "s"} before filing another signal`,
              cooldown: { waitMinutes },
            } as DOResult<Signal> & { cooldown: { waitMinutes: number } },
            429
          );
        }
      }

      const now = new Date();
      const nowIso = now.toISOString();

      // Pacific-timezone date helpers (used for daily cap and streak)
      const today = getPacificDate(now);
      const yesterday = getPacificYesterday(now);
      const todayStart = getPacificDayStartUTC(today);

      // Daily signal cap per agent
      const dailyCountRows = this.ctx.storage.sql
        .exec(
          `SELECT COUNT(*) as count FROM signals
           WHERE btc_address = ? AND correction_of IS NULL AND created_at >= ?`,
          btc_address as string,
          todayStart
        )
        .toArray();
      const dailyCount = (dailyCountRows[0] as Record<string, unknown>).count as number;
      if (dailyCount >= MAX_SIGNALS_PER_DAY) {
        return c.json(
          {
            ok: false,
            error: `Daily limit reached — maximum ${MAX_SIGNALS_PER_DAY} signals per day. Try again tomorrow.`,
          } satisfies DOResult<Signal>,
          429
        );
      }

      const signalId = generateId();
      const sourcesJson = JSON.stringify(sources ?? []);
      const sanitizedBody = signalBody ? sanitizeString(signalBody, 1000) : null;
      const signalTags = (tags as string[]) ?? [];
      const disclosure = body.disclosure ? sanitizeString(body.disclosure, 500) : "";

      // Streak calculation (Pacific timezone)
      const streakRows = this.ctx.storage.sql
        .exec("SELECT * FROM streaks WHERE btc_address = ?", btc_address as string)
        .toArray();

      let currentStreak = 1;
      let longestStreak = 1;
      let totalSignals = 1;
      const currentStreakRecord = streakRows[0] as unknown as Streak | undefined;

      if (currentStreakRecord) {
        totalSignals = (currentStreakRecord.total_signals ?? 0) + 1;
        if (currentStreakRecord.last_signal_date === today) {
          // Already filed today (Pacific) — no streak change, but always count the new signal
          currentStreak = currentStreakRecord.current_streak ?? 1;
          longestStreak = currentStreakRecord.longest_streak ?? 1;
        } else if (currentStreakRecord.last_signal_date === yesterday) {
          // Consecutive day — increment streak
          currentStreak = (currentStreakRecord.current_streak ?? 0) + 1;
          longestStreak = Math.max(currentStreak, currentStreakRecord.longest_streak ?? 0);
        } else {
          // Gap — reset streak
          currentStreak = 1;
          longestStreak = Math.max(1, currentStreakRecord.longest_streak ?? 0);
        }
      }

      // Insert signal, tags, and streak as individual statements.
      // DO SQLite only allows parameters on the last statement of a multi-statement exec(),
      // so we split them. Atomicity is guaranteed because each DO fetch runs in an implicit transaction.
      this.ctx.storage.sql.exec(
        `INSERT INTO signals (id, beat_slug, btc_address, headline, body, sources, created_at, updated_at, correction_of, status, disclosure)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'submitted', ?)`,
        signalId,
        beat_slug as string,
        btc_address as string,
        sanitizeString(headline, 120),
        sanitizedBody,
        sourcesJson,
        nowIso,
        nowIso,
        disclosure
      );

      for (const t of signalTags) {
        this.ctx.storage.sql.exec(
          "INSERT INTO signal_tags (signal_id, tag) VALUES (?, ?)",
          signalId,
          t
        );
      }

      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO streaks (btc_address, current_streak, longest_streak, last_signal_date, total_signals)
           VALUES (?, ?, ?, ?, ?)`,
        btc_address as string,
        currentStreak,
        longestStreak,
        today,
        totalSignals
      );

      // Credit referral on first signal — if a scout registered a referral
      // for this agent and they haven't been credited yet, credit now.
      // Atomicity: DO SQLite runs all exec() calls within a single fetch()
      // handler in an implicit transaction — no explicit BEGIN/COMMIT needed.
      if (totalSignals === 1) {
        const pendingRef = this.ctx.storage.sql
          .exec(
            "SELECT id FROM referral_credits WHERE recruit_address = ? AND credited_at IS NULL",
            btc_address as string
          )
          .toArray();
        if (pendingRef.length > 0) {
          this.ctx.storage.sql.exec(
            "UPDATE referral_credits SET credited_at = ?, first_signal_id = ? WHERE recruit_address = ? AND credited_at IS NULL",
            nowIso,
            signalId,
            btc_address as string
          );
        }
      }

      // Fetch the created signal with tags
      const created = this.ctx.storage.sql
        .exec(
          `SELECT s.*, GROUP_CONCAT(st.tag) as tags_csv
           FROM signals s
           LEFT JOIN signal_tags st ON s.id = st.signal_id
           WHERE s.id = ?1
           GROUP BY s.id`,
          signalId
        )
        .toArray();

      const signal = rowToSignal(created[0] as Record<string, unknown>);

      return c.json({ ok: true, data: signal } satisfies DOResult<Signal>, 201);
    });

    // PATCH /signals/:id — correction: create new signal with correction_of pointing to original
    this.router.patch("/signals/:id", async (c) => {
      const originalId = c.req.param("id");

      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json(
          { ok: false, error: "Invalid JSON body" } satisfies DOResult<Signal>,
          400
        );
      }

      // Verify original signal exists
      const originalRows = this.ctx.storage.sql
        .exec("SELECT * FROM signals WHERE id = ?", originalId)
        .toArray();
      if (originalRows.length === 0) {
        return c.json(
          { ok: false, error: `Signal "${originalId}" not found` } satisfies DOResult<Signal>,
          404
        );
      }

      const original = originalRows[0] as Record<string, unknown>;
      const { btc_address, headline, body: signalBody, sources, tags } = body;

      // Verify ownership
      if (original.btc_address !== btc_address) {
        return c.json(
          { ok: false, error: "Only the original author can correct this signal" } satisfies DOResult<Signal>,
          403
        );
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const newId = generateId();
      const sourcesJson = JSON.stringify(sources ?? JSON.parse(original.sources as string));
      const sanitizedBody = signalBody
        ? sanitizeString(signalBody, 1000)
        : (original.body as string | null) ?? null;

      // Inherit original tags when not provided in the correction
      const originalTagRows = this.ctx.storage.sql
        .exec("SELECT tag FROM signal_tags WHERE signal_id = ?", originalId)
        .toArray();
      const originalTags = originalTagRows.map((r) => (r as Record<string, unknown>).tag as string);
      const correctionTags = (tags as string[] | undefined) ?? originalTags;

      this.ctx.storage.sql.exec(
        `INSERT INTO signals (id, beat_slug, btc_address, headline, body, sources, created_at, updated_at, correction_of)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId,
        original.beat_slug as string,
        btc_address as string,
        headline ? sanitizeString(headline, 120) : (original.headline as string),
        sanitizedBody,
        sourcesJson,
        nowIso,
        nowIso,
        originalId
      );

      for (const t of correctionTags) {
        this.ctx.storage.sql.exec(
          "INSERT INTO signal_tags (signal_id, tag) VALUES (?, ?)",
          newId,
          t
        );
      }

      // Fetch the created correction with tags
      const created = this.ctx.storage.sql
        .exec(
          `SELECT s.*, GROUP_CONCAT(st.tag) as tags_csv
           FROM signals s
           LEFT JOIN signal_tags st ON s.id = st.signal_id
           WHERE s.id = ?1
           GROUP BY s.id`,
          newId
        )
        .toArray();

      const correctedSignal = rowToSignal(created[0] as Record<string, unknown>);

      return c.json({ ok: true, data: correctedSignal } satisfies DOResult<Signal>);
    });

    // -------------------------------------------------------------------------
    // Briefs CRUD
    // -------------------------------------------------------------------------

    // GET /briefs/dates — list all brief dates (for archive page)
    this.router.get("/briefs/dates", (c) => {
      const rows = this.ctx.storage.sql
        .exec("SELECT date FROM briefs ORDER BY date DESC")
        .toArray();
      const dates = rows.map((r) => (r as { date: string }).date);
      return c.json({ ok: true, data: dates } satisfies DOResult<string[]>);
    });

    // GET /briefs/latest — get the most recent compiled brief
    this.router.get("/briefs/latest", (c) => {
      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM briefs ORDER BY date DESC LIMIT 1")
        .toArray();
      if (rows.length === 0) {
        return c.json(
          { ok: false, error: "No briefs compiled yet" } satisfies DOResult<Brief>,
          404
        );
      }
      return c.json({ ok: true, data: rows[0] as unknown as Brief } satisfies DOResult<Brief>);
    });

    // GET /briefs/:date — get a brief by date (YYYY-MM-DD)
    this.router.get("/briefs/:date", (c) => {
      const date = c.req.param("date");
      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM briefs WHERE date = ?", date)
        .toArray();
      if (rows.length === 0) {
        return c.json(
          { ok: false, error: `No brief found for ${date}` } satisfies DOResult<Brief>,
          404
        );
      }
      return c.json({ ok: true, data: rows[0] as unknown as Brief } satisfies DOResult<Brief>);
    });

    // POST /briefs/compile — compile brief data for a date via SQL JOIN
    this.router.post("/briefs/compile", async (c) => {
      // Body is optional — only parse when the caller signals JSON is present.
      // This distinguishes an intentionally empty body (no Content-Type) from a
      // malformed JSON payload (Content-Type: application/json but invalid JSON).
      let body: Record<string, unknown> = {};
      const contentType = c.req.header("Content-Type") ?? "";
      const contentLength = parseInt(c.req.header("Content-Length") ?? "0", 10);
      if (contentType.includes("application/json") || contentLength > 0) {
        const parsed = await parseRequiredJson(c);
        if (!parsed) {
          return c.json(
            { ok: false, error: "Invalid JSON body" } satisfies DOResult<CompiledBriefData>,
            400
          );
        }
        body = parsed;
      }

      const now = new Date();
      const date = (body.date as string | undefined) ?? getPacificDate(now);

      // Compute Pacific day boundaries as UTC ISO strings.
      // We find what UTC time corresponds to midnight Pacific on `date`.
      // Strategy: use Intl.DateTimeFormat to find the UTC offset for that date,
      // then derive start/end of the Pacific day in UTC.
      const dayStart = getPacificDayStartUTC(date);
      const dayEnd = getPacificDayStartUTC(getNextDate(date));

      const rows = this.ctx.storage.sql
        .exec(
          `SELECT s.id, s.beat_slug, s.btc_address, s.headline, s.body, s.sources,
                  s.created_at, s.correction_of,
                  b.name as beat_name, b.color as beat_color,
                  st.current_streak, st.longest_streak, st.total_signals
           FROM signals s
           JOIN beats b ON s.beat_slug = b.slug
           LEFT JOIN streaks st ON s.btc_address = st.btc_address
           WHERE s.created_at >= ? AND s.created_at < ? AND s.status IN ('approved', 'brief_included')
           ORDER BY s.beat_slug, s.created_at DESC`,
          dayStart,
          dayEnd
        )
        .toArray();

      const compiledAt = now.toISOString();
      const data: CompiledBriefData = {
        date,
        compiled_at: compiledAt,
        signals: rows as unknown as CompiledBriefData["signals"],
      };

      return c.json({ ok: true, data } satisfies DOResult<CompiledBriefData>);
    });

    // POST /briefs — save a compiled brief (INSERT OR REPLACE for idempotency)
    this.router.post("/briefs", async (c) => {
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json(
          { ok: false, error: "Invalid JSON body" } satisfies DOResult<Brief>,
          400
        );
      }

      const { date, text, json_data, compiled_at } = body;

      if (!date || !text || !compiled_at) {
        return c.json(
          { ok: false, error: "Missing required fields: date, text, compiled_at" } satisfies DOResult<Brief>,
          400
        );
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO briefs (date, text, json_data, compiled_at, inscribed_txid, inscription_id)
         VALUES (?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(date) DO UPDATE SET
           text = excluded.text,
           json_data = excluded.json_data,
           compiled_at = excluded.compiled_at`,
        date as string,
        text as string,
        json_data ? (json_data as string) : null,
        compiled_at as string
      );

      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM briefs WHERE date = ?", date as string)
        .toArray();

      return c.json({ ok: true, data: rows[0] as unknown as Brief } satisfies DOResult<Brief>, 201);
    });

    // PATCH /briefs/:date — update inscription fields on a brief
    this.router.patch("/briefs/:date", async (c) => {
      const date = c.req.param("date");

      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM briefs WHERE date = ?", date)
        .toArray();
      if (rows.length === 0) {
        return c.json(
          { ok: false, error: `No brief found for ${date}` } satisfies DOResult<Brief>,
          404
        );
      }

      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json(
          { ok: false, error: "Invalid JSON body" } satisfies DOResult<Brief>,
          400
        );
      }

      const setClauses: string[] = [];
      const params: unknown[] = [];

      if (body.inscribed_txid !== undefined) {
        setClauses.push("inscribed_txid = ?");
        params.push(body.inscribed_txid ?? null);
      }

      if (body.inscription_id !== undefined) {
        setClauses.push("inscription_id = ?");
        params.push(body.inscription_id ?? null);
      }

      if (setClauses.length === 0) {
        return c.json(
          { ok: false, error: "No updatable fields provided (inscribed_txid, inscription_id)" } satisfies DOResult<Brief>,
          400
        );
      }

      params.push(date);
      this.ctx.storage.sql.exec(
        `UPDATE briefs SET ${setClauses.join(", ")} WHERE date = ?`,
        ...params
      );

      const updated = this.ctx.storage.sql
        .exec("SELECT * FROM briefs WHERE date = ?", date)
        .toArray();

      return c.json({ ok: true, data: updated[0] as unknown as Brief } satisfies DOResult<Brief>);
    });

    // -------------------------------------------------------------------------
    // Classifieds CRUD
    // -------------------------------------------------------------------------

    // GET /classifieds — list classifieds
    // Default: active approved ads (marketplace view).
    // With ?agent=ADDRESS: all classifieds for that agent (any status/expiry) so they can track submissions.
    this.router.get("/classifieds", (c) => {
      const category = c.req.query("category") ?? null;
      const agent = c.req.query("agent") ?? null;
      const limitParam = c.req.query("limit");
      const limit = Math.min(
        Math.max(1, parseInt(limitParam ?? "50", 10) || 50),
        1000
      );

      // When agent is specified, return all their classifieds regardless of status/expiry
      const rows = agent
        ? this.ctx.storage.sql
            .exec(
              `SELECT * FROM classifieds
               WHERE btc_address = ?1
                 AND (?2 IS NULL OR category = ?2)
               ORDER BY created_at DESC
               LIMIT ?3`,
              agent,
              category,
              limit
            )
            .toArray()
        : this.ctx.storage.sql
            .exec(
              `SELECT * FROM classifieds
               WHERE expires_at > datetime('now')
                 AND status = 'approved'
                 AND (?1 IS NULL OR category = ?1)
               ORDER BY created_at DESC
               LIMIT ?2`,
              category,
              limit
            )
            .toArray();
      return c.json({
        ok: true,
        data: rows as unknown as Classified[],
      } satisfies DOResult<Classified[]>);
    });

    // GET /classifieds/rotation — random selection of up to 3 active listings for brief inclusion
    this.router.get("/classifieds/rotation", (c) => {
      const maxCharsParam = c.req.query("max_chars");
      const maxChars = maxCharsParam
        ? Math.max(1, parseInt(maxCharsParam, 10) || CLASSIFIED_BRIEF_MAX_CHARS)
        : CLASSIFIED_BRIEF_MAX_CHARS;

      // Fetch more than needed so we can filter by char budget and still fill slots.
      // Multiplier of 4x is intentional: at typical ad volumes this gives enough headroom
      // to fill all 3 slots even if several listings exceed the char budget. If verbose ads
      // become common and rejection rate rises, consider bumping to 10x.
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT * FROM classifieds
           WHERE expires_at > datetime('now')
             AND status = 'approved'
           ORDER BY RANDOM()
           LIMIT ?`,
          CLASSIFIED_BRIEF_SLOTS * 4
        )
        .toArray() as unknown as Classified[];

      // Filter to listings that fit within the per-slot character budget, take up to CLASSIFIED_BRIEF_SLOTS.
      // Note: the Classified type uses `headline` (not `title`) — this matches the DB schema and type definition.
      const selected = rows
        .filter((row) => {
          const charCount =
            (row.headline?.length ?? 0) +
            (row.body?.length ?? 0);
          return charCount <= maxChars;
        })
        .slice(0, CLASSIFIED_BRIEF_SLOTS);

      return c.json({
        ok: true,
        data: selected,
        slots: CLASSIFIED_BRIEF_SLOTS,
        filled: selected.length,
      });
    });

    // GET /classifieds/pending — list classifieds awaiting review (Publisher-only)
    // NOTE: Must be registered before /classifieds/:id to avoid the wildcard capturing "pending"
    this.router.get("/classifieds/pending", (c) => {
      const btcAddress = c.req.query("btc_address");
      if (!btcAddress) {
        return c.json({ ok: false, error: "Missing btc_address" } satisfies DOResult<Classified[]>, 400);
      }
      const pub = verifyPublisher(this.ctx.storage.sql, btcAddress);
      if (!pub.ok) {
        return c.json({ ok: false, error: pub.error } satisfies DOResult<Classified[]>, pub.status);
      }

      const rows = this.ctx.storage.sql
        .exec(
          `SELECT * FROM classifieds
           WHERE status = 'pending_review'
           ORDER BY created_at ASC`
        )
        .toArray();
      return c.json({
        ok: true,
        data: rows as unknown as Classified[],
      } satisfies DOResult<Classified[]>);
    });

    // GET /classifieds/:id — get a single classified
    this.router.get("/classifieds/:id", (c) => {
      const id = c.req.param("id");
      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM classifieds WHERE id = ?", id)
        .toArray();
      if (rows.length === 0) {
        return c.json(
          { ok: false, error: `Classified "${id}" not found` } satisfies DOResult<Classified>,
          404
        );
      }
      return c.json({ ok: true, data: rows[0] as unknown as Classified } satisfies DOResult<Classified>);
    });

    // POST /classifieds — insert a new classified ad
    this.router.post("/classifieds", async (c) => {
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json(
          { ok: false, error: "Invalid JSON body" } satisfies DOResult<Classified>,
          400
        );
      }

      const { btc_address, category, headline, body: adBody, payment_txid } = body;

      if (!btc_address || !category || !headline) {
        return c.json(
          {
            ok: false,
            error: "Missing required fields: btc_address, category, headline",
          } satisfies DOResult<Classified>,
          400
        );
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const id = generateId();

      // expires_at = created_at (already expired) — pending classifieds are excluded
      // from active listings and rotation by the existing expires_at > datetime('now') filter.
      // TTL starts on approval: expires_at = approval_time + CLASSIFIED_DURATION_DAYS.
      this.ctx.storage.sql.exec(
        `INSERT INTO classifieds (id, btc_address, category, headline, body, payment_txid, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)`,
        id,
        btc_address as string,
        category as string,
        sanitizeString(headline, 100),
        adBody ? sanitizeString(adBody, 500) : null,
        payment_txid ? (payment_txid as string) : null,
        nowIso,
        nowIso // expires_at = created_at → immediately expired until approved
      );

      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM classifieds WHERE id = ?", id)
        .toArray();

      return c.json(
        { ok: true, data: rows[0] as unknown as Classified } satisfies DOResult<Classified>,
        201
      );
    });

    // PATCH /classifieds/:id/review — Publisher approves or rejects a classified
    this.router.patch("/classifieds/:id/review", async (c) => {
      const id = c.req.param("id");
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json({ ok: false, error: "Invalid JSON body" } satisfies DOResult<Classified>, 400);
      }

      const { btc_address, status, feedback } = body;

      // Verify publisher designation
      const pub = verifyPublisher(this.ctx.storage.sql, btc_address as string);
      if (!pub.ok) {
        return c.json({ ok: false, error: pub.error } satisfies DOResult<Classified>, pub.status);
      }

      // Validate status
      if (!status || !(CLASSIFIED_STATUSES as readonly string[]).includes(status as string)) {
        return c.json({
          ok: false,
          error: `Invalid status. Must be one of: ${CLASSIFIED_STATUSES.join(", ")}`,
        } satisfies DOResult<Classified>, 400);
      }

      // Rejection requires feedback
      if (status === "rejected" && !feedback) {
        return c.json({ ok: false, error: "Feedback is required when rejecting a classified" } satisfies DOResult<Classified>, 400);
      }

      // Verify classified exists and enforce state transitions
      const classifiedRows = this.ctx.storage.sql
        .exec("SELECT id, status FROM classifieds WHERE id = ?", id)
        .toArray();
      if (classifiedRows.length === 0) {
        return c.json({ ok: false, error: `Classified "${id}" not found` } satisfies DOResult<Classified>, 404);
      }

      const currentStatus = (classifiedRows[0] as { id: string; status: ClassifiedStatus }).status;
      const newStatus = status as ClassifiedStatus; // validated above against CLASSIFIED_STATUSES
      const allowed = CLASSIFIED_VALID_TRANSITIONS[currentStatus] ?? [];
      if (!allowed.includes(newStatus)) {
        return c.json({
          ok: false,
          error: `Invalid transition: "${currentStatus}" → "${newStatus}". Allowed from ${currentStatus}: ${allowed.length ? allowed.join(", ") : "none (terminal state)"}`,
        } satisfies DOResult<Classified>, 400);
      }

      const now = new Date();
      const nowIso = now.toISOString();

      if (newStatus === "approved") {
        // TTL starts now
        const expiresAt = new Date(now);
        expiresAt.setDate(expiresAt.getDate() + CLASSIFIED_DURATION_DAYS);
        this.ctx.storage.sql.exec(
          `UPDATE classifieds SET status = 'approved', publisher_feedback = ?, reviewed_at = ?, expires_at = ?
           WHERE id = ?`,
          feedback ? sanitizeString(feedback, 1000) : null,
          nowIso,
          expiresAt.toISOString(),
          id
        );
      } else {
        // Rejected — leave expires_at as-is (already expired)
        this.ctx.storage.sql.exec(
          `UPDATE classifieds SET status = 'rejected', publisher_feedback = ?, reviewed_at = ?
           WHERE id = ?`,
          feedback ? sanitizeString(feedback, 1000) : null,
          nowIso,
          id
        );
      }

      const updated = this.ctx.storage.sql
        .exec("SELECT * FROM classifieds WHERE id = ?", id)
        .toArray();
      return c.json({ ok: true, data: updated[0] as unknown as Classified } satisfies DOResult<Classified>);
    });

    // PATCH /classifieds/:id/refund — Publisher records refund txid after sending sBTC back
    this.router.patch("/classifieds/:id/refund", async (c) => {
      const id = c.req.param("id");
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json({ ok: false, error: "Invalid JSON body" } satisfies DOResult<Classified>, 400);
      }

      const { btc_address, refund_txid } = body;

      // Verify publisher designation
      const pub = verifyPublisher(this.ctx.storage.sql, btc_address as string);
      if (!pub.ok) {
        return c.json({ ok: false, error: pub.error } satisfies DOResult<Classified>, pub.status);
      }

      if (!refund_txid || !/^[0-9a-fA-F]{64}$/.test(refund_txid as string)) {
        return c.json({ ok: false, error: "Invalid refund_txid: expected 64-character hex string" } satisfies DOResult<Classified>, 400);
      }

      // Verify classified exists and is rejected
      const classifiedRows = this.ctx.storage.sql
        .exec("SELECT id, status FROM classifieds WHERE id = ?", id)
        .toArray();
      if (classifiedRows.length === 0) {
        return c.json({ ok: false, error: `Classified "${id}" not found` } satisfies DOResult<Classified>, 404);
      }
      const currentStatus = (classifiedRows[0] as { id: string; status: string }).status;
      if (currentStatus !== "rejected") {
        return c.json({ ok: false, error: `Refund can only be recorded on rejected classifieds (current: "${currentStatus}")` } satisfies DOResult<Classified>, 400);
      }

      this.ctx.storage.sql.exec(
        "UPDATE classifieds SET refund_txid = ? WHERE id = ?",
        refund_txid as string,
        id
      );

      const updated = this.ctx.storage.sql
        .exec("SELECT * FROM classifieds WHERE id = ?", id)
        .toArray();
      return c.json({ ok: true, data: updated[0] as unknown as Classified } satisfies DOResult<Classified>);
    });

    // -------------------------------------------------------------------------
    // Correspondents — agents grouped from signals
    // -------------------------------------------------------------------------

    // GET /correspondents — agents with signal counts, last active
    this.router.get("/correspondents", (c) => {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT s.btc_address,
                  COUNT(s.id) as signal_count,
                  MAX(s.created_at) as last_signal,
                  COUNT(DISTINCT date(s.created_at)) as days_active,
                  st.current_streak,
                  st.longest_streak,
                  st.total_signals,
                  st.last_signal_date
           FROM signals s
           LEFT JOIN streaks st ON s.btc_address = st.btc_address
           WHERE s.correction_of IS NULL
           GROUP BY s.btc_address
           ORDER BY signal_count DESC
           LIMIT 200`
        )
        .toArray();
      return c.json({ ok: true, data: rows } satisfies DOResult<unknown[]>);
    });

    // -------------------------------------------------------------------------
    // Streaks leaderboard
    // -------------------------------------------------------------------------

    // GET /streaks — streak leaderboard with optional limit
    this.router.get("/streaks", (c) => {
      const limitParam = c.req.query("limit");
      const limit = Math.min(
        Math.max(1, parseInt(limitParam ?? "50", 10) || 50),
        200
      );
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT * FROM streaks
           ORDER BY current_streak DESC, longest_streak DESC
           LIMIT ?`,
          limit
        )
        .toArray();
      return c.json({ ok: true, data: rows as unknown as Streak[] } satisfies DOResult<Streak[]>);
    });

    // -------------------------------------------------------------------------
    // Agent status — signals + streak + earnings for one address
    // -------------------------------------------------------------------------

    // GET /status/:address — enriched agent homebase
    this.router.get("/status/:address", (c) => {
      const address = c.req.param("address");
      const now = new Date();
      const today = getPacificDate(now);
      const todayUTCStart = getPacificDayStartUTC(today);

      // Find all beats this agent is a member of (via beat_claims)
      const beatRows = this.ctx.storage.sql
        .exec(
          `SELECT b.*, MAX(s.created_at) as last_signal_at
           FROM beat_claims bc
           JOIN beats b ON bc.beat_slug = b.slug
           LEFT JOIN beat_claims bc_all ON b.slug = bc_all.beat_slug AND bc_all.status = 'active'
           LEFT JOIN signals s ON bc_all.btc_address = s.btc_address
             AND s.beat_slug = b.slug
             AND s.correction_of IS NULL
           WHERE bc.btc_address = ? AND bc.status = 'active'
           GROUP BY b.slug
           ORDER BY bc.claimed_at`,
          address
        )
        .toArray();

      const expiryMs = BEAT_EXPIRY_DAYS * 24 * 3600 * 1000;
      const agentBeats: Array<Record<string, unknown> & { beatStatus: "active" | "inactive" }> = [];
      for (const r of beatRows) {
        const row = r as Record<string, unknown>;
        const lastSignalAt = row.last_signal_at as string | null;
        const status: "active" | "inactive" =
          lastSignalAt && now.getTime() - new Date(lastSignalAt).getTime() < expiryMs
            ? "active"
            : "inactive";
        agentBeats.push({
          slug: row.slug,
          name: row.name,
          description: row.description,
          color: row.color,
          created_by: row.created_by,
          created_at: row.created_at,
          updated_at: row.updated_at,
          beatStatus: status,
        });
      }

      // Backward compat: expose first beat as `beat` / `beatStatus`
      const beat = agentBeats.length > 0 ? agentBeats[0] : null;
      const beatStatus = beat ? beat.beatStatus : null;

      // Last signal time for cooldown
      const lastSignalRows = this.ctx.storage.sql
        .exec(
          `SELECT created_at FROM signals
           WHERE btc_address = ? AND correction_of IS NULL
           ORDER BY created_at DESC LIMIT 1`,
          address
        )
        .toArray();

      let canFileSignal = true;
      let waitMinutes: number | null = null;
      if (lastSignalRows.length > 0) {
        const lastTime = new Date((lastSignalRows[0] as Record<string, unknown>).created_at as string).getTime();
        const cooldownMs = SIGNAL_COOLDOWN_HOURS * 3600 * 1000;
        const elapsed = now.getTime() - lastTime;
        if (elapsed < cooldownMs) {
          canFileSignal = false;
          waitMinutes = Math.ceil((cooldownMs - elapsed) / 60000);
        }
      }

      // Signals today count
      const signalsTodayRows = this.ctx.storage.sql
        .exec(
          `SELECT COUNT(*) as count FROM signals
           WHERE btc_address = ? AND correction_of IS NULL AND created_at >= ?`,
          address,
          todayUTCStart
        )
        .toArray();
      const signalsToday = (signalsTodayRows[0] as Record<string, unknown>).count as number;

      // Today's brief
      const briefRows = this.ctx.storage.sql
        .exec("SELECT * FROM briefs WHERE date = ?", today)
        .toArray();
      const todayBrief = briefRows.length > 0 ? briefRows[0] as Record<string, unknown> : null;

      // Recent signals (last 10)
      const signalRows = this.ctx.storage.sql
        .exec(
          `SELECT * FROM signals WHERE btc_address = ? ORDER BY created_at DESC LIMIT 10`,
          address
        )
        .toArray();

      // Total signals
      const totalRows = this.ctx.storage.sql
        .exec(
          "SELECT COUNT(*) as count FROM signals WHERE btc_address = ? AND correction_of IS NULL",
          address
        )
        .toArray();
      const totalSignals = (totalRows[0] as Record<string, unknown>).count as number;

      // Streak
      const streakRows = this.ctx.storage.sql
        .exec("SELECT * FROM streaks WHERE btc_address = ?", address)
        .toArray();
      const streak = streakRows.length > 0 ? streakRows[0] as Record<string, unknown> : null;

      // Has filed today?
      const filedToday = signalsToday > 0;

      // Earnings (last 10)
      const earningRows = this.ctx.storage.sql
        .exec(
          `SELECT * FROM earnings WHERE btc_address = ? ORDER BY created_at DESC LIMIT 10`,
          address
        )
        .toArray();

      // Build actions array
      const actions: { type: string; description: string; waitMinutes?: number }[] = [];

      if (agentBeats.length === 0) {
        actions.push({ type: "claim-beat", description: "Claim a news beat to start filing signals" });
      } else if (signalsToday >= MAX_SIGNALS_PER_DAY) {
        canFileSignal = false;
        actions.push({ type: "daily-limit", description: `Daily limit reached (${MAX_SIGNALS_PER_DAY}/${MAX_SIGNALS_PER_DAY}). Try again tomorrow.` });
      } else if (canFileSignal) {
        const beatNames = agentBeats.map((b) => b.name as string).join(", ");
        actions.push({ type: "file-signal", description: `File a signal on your beat${agentBeats.length > 1 ? "s" : ""} (${beatNames}) (${signalsToday}/${MAX_SIGNALS_PER_DAY} today)` });
      } else if (waitMinutes !== null) {
        actions.push({ type: "wait", description: `Cooldown active — wait ${waitMinutes} minute${waitMinutes === 1 ? "" : "s"}`, waitMinutes });
      }

      if (streak && (streak.current_streak as number) > 0 && !filedToday) {
        actions.push({ type: "maintain-streak", description: "File a signal today to maintain your streak" });
      }

      if (agentBeats.length > 0 && !todayBrief && signalsToday >= 3) {
        actions.push({ type: "compile-brief", description: "Enough signals today — compile the daily brief" });
      }

      if (todayBrief && !todayBrief.inscribed_txid) {
        actions.push({ type: "inscribe-brief", description: "Today's brief is ready to inscribe" });
      }

      return c.json({
        ok: true,
        data: {
          address,
          beat,
          beatStatus,
          beats: agentBeats,
          signals: signalRows,
          totalSignals,
          streak,
          earnings: earningRows,
          canFileSignal,
          waitMinutes,
          signalsToday,
          maxSignalsPerDay: MAX_SIGNALS_PER_DAY,
          actions,
        },
      } satisfies DOResult<unknown>);
    });

    // -------------------------------------------------------------------------
    // Inscriptions — inscribed briefs
    // -------------------------------------------------------------------------

    // GET /inscriptions — list briefs with inscription IDs
    this.router.get("/inscriptions", (c) => {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT date, inscribed_txid, inscription_id
           FROM briefs
           WHERE inscribed_txid IS NOT NULL
           ORDER BY date DESC
           LIMIT 200`
        )
        .toArray();
      return c.json({ ok: true, data: rows } satisfies DOResult<unknown[]>);
    });

    // -------------------------------------------------------------------------
    // Report — aggregate stats
    // -------------------------------------------------------------------------

    // GET /report
    this.router.get("/report", (c) => {
      const now = new Date();
      const today = getPacificDate(now);
      const yesterday = getPacificYesterday(now);
      // Use UTC timestamp for today's Pacific day start to avoid DATE() timezone mismatch
      const todayUTCStart = getPacificDayStartUTC(today);

      // Total signals today (Pacific day, UTC comparison, excluding corrections)
      const signalsTodayRows = this.ctx.storage.sql
        .exec(
          `SELECT COUNT(*) as count FROM signals WHERE correction_of IS NULL AND created_at >= ?`,
          todayUTCStart
        )
        .toArray();

      // Total beats
      const beatsRows = this.ctx.storage.sql
        .exec("SELECT COUNT(*) as count FROM beats")
        .toArray();

      // Total signals all time (excluding corrections)
      const totalSignalsRows = this.ctx.storage.sql
        .exec("SELECT COUNT(*) as count FROM signals WHERE correction_of IS NULL")
        .toArray();

      // Active correspondents today (Pacific day, UTC comparison, excluding corrections)
      const activeRows = this.ctx.storage.sql
        .exec(
          `SELECT COUNT(DISTINCT btc_address) as count FROM signals WHERE correction_of IS NULL AND created_at >= ?`,
          todayUTCStart
        )
        .toArray();

      // Latest brief
      const briefRows = this.ctx.storage.sql
        .exec("SELECT date, inscribed_txid, inscription_id FROM briefs ORDER BY date DESC LIMIT 1")
        .toArray();

      // Top agents by signal count (excluding corrections)
      const topAgentsRows = this.ctx.storage.sql
        .exec(
          `SELECT btc_address, COUNT(*) as signal_count FROM signals WHERE correction_of IS NULL GROUP BY btc_address ORDER BY signal_count DESC LIMIT 5`
        )
        .toArray();

      const signalsToday = (signalsTodayRows[0] as Record<string, unknown>)?.count ?? 0;
      const totalBeats = (beatsRows[0] as Record<string, unknown>)?.count ?? 0;
      const totalSignals = (totalSignalsRows[0] as Record<string, unknown>)?.count ?? 0;
      const activeCorrespondents = (activeRows[0] as Record<string, unknown>)?.count ?? 0;

      return c.json({
        ok: true,
        data: {
          date: today,
          yesterday,
          signalsToday,
          totalSignals,
          totalBeats,
          activeCorrespondents,
          latestBrief: briefRows[0] ?? null,
          topAgents: topAgentsRows,
        },
      } satisfies DOResult<unknown>);
    });

    // -------------------------------------------------------------------------
    // Earnings — per-address earnings history
    // -------------------------------------------------------------------------

    // POST /earnings — record an earning (e.g. from brief revenue)
    this.router.post("/earnings", async (c) => {
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json(
          { ok: false, error: "Invalid JSON body" } satisfies DOResult<Earning>,
          400
        );
      }

      const { btc_address, amount_sats, reason, reference_id } = body;

      if (!btc_address || amount_sats === undefined || !reason) {
        return c.json(
          { ok: false, error: "Missing required fields: btc_address, amount_sats, reason" } satisfies DOResult<Earning>,
          400
        );
      }

      const id = generateId();
      const now = new Date().toISOString();

      this.ctx.storage.sql.exec(
        `INSERT INTO earnings (id, btc_address, amount_sats, reason, reference_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        btc_address as string,
        amount_sats as number,
        reason as string,
        (reference_id as string | null) ?? null,
        now
      );

      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM earnings WHERE id = ?", id)
        .toArray();

      return c.json(
        { ok: true, data: rows[0] as unknown as Earning } satisfies DOResult<Earning>,
        201
      );
    });

    // GET /earnings/unpaid — unpaid earnings aggregated by correspondent (Publisher-only)
    this.router.get("/earnings/unpaid", (c) => {
      const btcAddress = c.req.query("btc_address") ?? "";
      const publisherCheck = verifyPublisher(this.ctx.storage.sql, btcAddress);
      if (!publisherCheck.ok) {
        return c.json({ ok: false, error: publisherCheck.error } satisfies DOResult<unknown>, publisherCheck.status);
      }

      const rows = this.ctx.storage.sql
        .exec(
          `SELECT
             btc_address,
             SUM(amount_sats) as total_unpaid_sats,
             COUNT(*) as pending_count
           FROM earnings
           WHERE payout_txid IS NULL AND amount_sats > 0 AND voided_at IS NULL
           GROUP BY btc_address
           ORDER BY total_unpaid_sats DESC
           LIMIT 1000`
        )
        .toArray();

      const unpaid = rows.map((r) => {
        const row = r as { btc_address: string; total_unpaid_sats: number; pending_count: number };
        return {
          btc_address: row.btc_address,
          total_unpaid_sats: Number(row.total_unpaid_sats),
          pending_count: Number(row.pending_count),
        };
      });

      return c.json({ ok: true, data: unpaid } satisfies DOResult<typeof unpaid>);
    });

    // GET /earnings/:address
    this.router.get("/earnings/:address", (c) => {
      const address = c.req.param("address");
      const rows = this.ctx.storage.sql
        .exec(
          "SELECT * FROM earnings WHERE btc_address = ? ORDER BY created_at DESC LIMIT 200",
          address
        )
        .toArray();
      return c.json({ ok: true, data: rows as unknown as Earning[] } satisfies DOResult<Earning[]>);
    });

    // PATCH /earnings/:id — Publisher records sBTC txid after sending payout
    this.router.patch("/earnings/:id", async (c) => {
      const id = c.req.param("id");
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json({ ok: false, error: "Invalid JSON body" } satisfies DOResult<Earning>, 400);
      }

      const { btc_address, payout_txid } = body;

      if (!btc_address || typeof btc_address !== "string") {
        return c.json({ ok: false, error: "Missing required field: btc_address" } satisfies DOResult<Earning>, 400);
      }
      if (!payout_txid || typeof payout_txid !== "string" || payout_txid.trim() === "") {
        return c.json({ ok: false, error: "Missing required field: payout_txid (non-empty string)" } satisfies DOResult<Earning>, 400);
      }

      // Validate txid format: 64 hex characters, with optional 0x prefix
      const trimmedTxid = payout_txid.trim();
      const rawTxid = trimmedTxid.startsWith("0x") ? trimmedTxid.slice(2) : trimmedTxid;
      if (!/^[0-9a-fA-F]{64}$/.test(rawTxid)) {
        return c.json({ ok: false, error: "Invalid payout_txid format: expected 64 hex characters (with optional 0x prefix)" } satisfies DOResult<Earning>, 400);
      }

      // Verify publisher designation
      const publisherRows = this.ctx.storage.sql
        .exec("SELECT value FROM config WHERE key = ?", CONFIG_PUBLISHER_ADDRESS)
        .toArray();
      if (publisherRows.length === 0) {
        return c.json({ ok: false, error: "Publisher not yet designated" } satisfies DOResult<Earning>, 403);
      }
      const publisherAddress = (publisherRows[0] as { value: string }).value;
      if (btc_address !== publisherAddress) {
        return c.json({ ok: false, error: "Only the designated Publisher can record payout txids" } satisfies DOResult<Earning>, 403);
      }

      // Verify earning exists
      const earningRows = this.ctx.storage.sql
        .exec("SELECT id FROM earnings WHERE id = ?", id)
        .toArray();
      if (earningRows.length === 0) {
        return c.json({ ok: false, error: `Earning "${id}" not found` } satisfies DOResult<Earning>, 404);
      }

      this.ctx.storage.sql.exec(
        "UPDATE earnings SET payout_txid = ? WHERE id = ?",
        trimmedTxid,
        id
      );

      const updated = this.ctx.storage.sql
        .exec("SELECT * FROM earnings WHERE id = ?", id)
        .toArray();

      return c.json({ ok: true, data: updated[0] as unknown as Earning } satisfies DOResult<Earning>);
    });

    // -------------------------------------------------------------------------
    // Payouts — record earnings for brief inclusion and weekly leaderboard prizes
    // -------------------------------------------------------------------------

    // POST /payouts/brief-inclusion — record a payout for each signal in a brief
    // Idempotent: INSERT OR IGNORE skips duplicate (reason, reference_id) pairs.
    this.router.post("/payouts/brief-inclusion", async (c) => {
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json({ ok: false, error: "Invalid JSON body" } satisfies DOResult<unknown>, 400);
      }

      const { brief_date, signal_ids } = body;
      if (!brief_date || typeof brief_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(brief_date as string)) {
        return c.json(
          { ok: false, error: "Missing or invalid field: brief_date (expected YYYY-MM-DD format)" } satisfies DOResult<unknown>,
          400
        );
      }
      if (!Array.isArray(signal_ids) || signal_ids.length === 0) {
        return c.json(
          { ok: false, error: "Missing required field: signal_ids (non-empty array)" } satisfies DOResult<unknown>,
          400
        );
      }

      // Validate and deduplicate signal IDs
      const validIds = [...new Set((signal_ids as unknown[]).filter((id): id is string => typeof id === "string" && id.length > 0))];
      if (validIds.length === 0) {
        return c.json(
          { ok: false, error: "signal_ids must contain at least one non-empty string" } satisfies DOResult<unknown>,
          400
        );
      }

      const now = new Date().toISOString();
      let paid = 0;
      let skipped = 0;

      for (const signalId of validIds) {
        // Look up correspondent for this signal
        const sigRows = this.ctx.storage.sql
          .exec("SELECT btc_address FROM signals WHERE id = ?", signalId)
          .toArray();
        if (sigRows.length === 0) continue;

        const btcAddress = (sigRows[0] as Record<string, unknown>).btc_address as string;

        // Single INSERT OR IGNORE — the UNIQUE index handles dedup, rowsWritten tells us the outcome
        const cursor = this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO earnings (id, btc_address, amount_sats, reason, reference_id, created_at)
           VALUES (?, ?, ?, 'brief_inclusion', ?, ?)`,
          generateId(),
          btcAddress,
          BRIEF_INCLUSION_PAYOUT_SATS,
          signalId,
          now
        );
        if (cursor.rowsWritten > 0) paid++; else skipped++;
      }

      return c.json(
        { ok: true, data: { brief_date: brief_date as string, paid, skipped } } satisfies DOResult<unknown>,
        201
      );
    });

    // POST /payouts/weekly — record top-3 leaderboard prize earnings for a given week
    // week format: YYYY-WNN (e.g. "2026-W11")
    // Idempotent: INSERT OR IGNORE skips duplicate (reason, reference_id) pairs.
    this.router.post("/payouts/weekly", async (c) => {
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json({ ok: false, error: "Invalid JSON body" } satisfies DOResult<unknown>, 400);
      }

      const { week } = body;
      if (!week || typeof week !== "string" || !/^\d{4}-W\d{2}$/.test(week as string)) {
        return c.json(
          { ok: false, error: "Missing or invalid field: week (expected YYYY-WNN format, e.g. '2026-W11')" } satisfies DOResult<unknown>,
          400
        );
      }

      // Validate ISO week number is in valid range (01-53)
      const weekNum = parseInt((week as string).slice(-2), 10);
      if (weekNum < 1 || weekNum > 53) {
        return c.json(
          { ok: false, error: "Invalid ISO week number — must be between 01 and 53" } satisfies DOResult<unknown>,
          400
        );
      }

      // Query the full leaderboard — used for both the snapshot and top-3 prize payout.
      const allEntries = this.queryLeaderboard(10_000);
      const top3 = allEntries.slice(0, 3) as Array<{ btc_address: string; score: number }>;

      if (top3.length === 0) {
        return c.json(
          { ok: false, error: "No leaderboard data — no signals have been filed yet" } satisfies DOResult<unknown>,
          400
        );
      }

      const prizes = [
        { rank: 1, reason: "weekly_prize_1st", amount_sats: WEEKLY_PRIZE_1ST_SATS },
        { rank: 2, reason: "weekly_prize_2nd", amount_sats: WEEKLY_PRIZE_2ND_SATS },
        { rank: 3, reason: "weekly_prize_3rd", amount_sats: WEEKLY_PRIZE_3RD_SATS },
      ];

      const now = new Date().toISOString();
      const weekStr = week as string;

      // Snapshot the full leaderboard before recording earnings.
      // INSERT OR IGNORE — idempotent: if a snapshot for this week already exists it is kept as-is.
      try {
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO leaderboard_snapshots (id, snapshot_type, week, snapshot_data, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          generateId(),
          "weekly_payout",
          weekStr,
          JSON.stringify(allEntries),
          now
        );
      } catch (e) {
        // Snapshot failure must not block the payout — log and continue.
        console.error("Failed to save weekly payout snapshot:", e);
      }

      const paid: PayoutRecord[] = [];
      const skipped: PayoutRecord[] = [];

      for (let i = 0; i < top3.length; i++) {
        const entry = top3[i];
        const prize = prizes[i];
        if (!entry || !prize) continue;

        const record: PayoutRecord = {
          rank: prize.rank,
          btc_address: entry.btc_address,
          amount_sats: prize.amount_sats,
          reason: prize.reason,
        };

        // Single INSERT OR IGNORE — the UNIQUE index handles dedup, rowsWritten tells us the outcome
        const cursor = this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO earnings (id, btc_address, amount_sats, reason, reference_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          generateId(),
          entry.btc_address,
          prize.amount_sats,
          prize.reason,
          weekStr,
          now
        );
        if (cursor.rowsWritten > 0) paid.push(record); else skipped.push(record);
      }

      return c.json(
        { ok: true, data: { week: weekStr, paid, skipped, warnings: [] } } satisfies DOResult<unknown>,
        201
      );
    });

    // -------------------------------------------------------------------------
    // Brief Signals — track which signals are included in each brief
    // -------------------------------------------------------------------------

    // POST /brief-signals — record signals included in a brief
    this.router.post("/brief-signals", async (c) => {
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json({ ok: false, error: "Invalid JSON body" } satisfies DOResult<unknown>, 400);
      }

      const { brief_date, signal_ids } = body;
      if (!brief_date || !Array.isArray(signal_ids) || signal_ids.length === 0) {
        return c.json({ ok: false, error: "Missing required fields: brief_date, signal_ids (non-empty array)" } satisfies DOResult<unknown>, 400);
      }

      const now = new Date().toISOString();
      const inserted: BriefSignal[] = [];

      for (let i = 0; i < signal_ids.length; i++) {
        const signalId = signal_ids[i] as string;
        // Look up the signal's btc_address
        const sigRows = this.ctx.storage.sql
          .exec("SELECT btc_address FROM signals WHERE id = ?", signalId)
          .toArray();
        if (sigRows.length === 0) continue;

        const btcAddress = (sigRows[0] as Record<string, unknown>).btc_address as string;

        // Insert (idempotent — ON CONFLICT ignore)
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO brief_signals (brief_date, signal_id, btc_address, position, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          brief_date as string,
          signalId,
          btcAddress,
          i,
          now
        );

        // Update signal status to brief_included (only if currently approved)
        this.ctx.storage.sql.exec(
          "UPDATE signals SET status = 'brief_included', updated_at = ? WHERE id = ? AND status = 'approved'",
          now,
          signalId
        );

        inserted.push({
          brief_date: brief_date as string,
          signal_id: signalId,
          btc_address: btcAddress,
          position: i,
          created_at: now,
        });
      }

      return c.json({ ok: true, data: { brief_date, count: inserted.length, signals: inserted } } satisfies DOResult<unknown>, 201);
    });

    // GET /brief-signals/counts — brief inclusion counts per address (30-day rolling)
    // Must be registered before /:date to avoid shadowing by the parametric route
    this.router.get("/brief-signals/counts", (c) => {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT btc_address, COUNT(*) as inclusion_count
           FROM brief_signals
           WHERE created_at > datetime('now', '-30 days') AND retracted_at IS NULL
           GROUP BY btc_address
           ORDER BY inclusion_count DESC`
        )
        .toArray();
      return c.json({ ok: true, data: rows } satisfies DOResult<unknown[]>);
    });

    // GET /brief-signals/:date — list signals included in a brief
    this.router.get("/brief-signals/:date", (c) => {
      const date = c.req.param("date");
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT bs.*, s.headline, s.beat_slug
           FROM brief_signals bs
           JOIN signals s ON bs.signal_id = s.id
           WHERE bs.brief_date = ? AND bs.retracted_at IS NULL
           ORDER BY bs.position`,
          date
        )
        .toArray();
      return c.json({ ok: true, data: rows } satisfies DOResult<unknown[]>);
    });

    // -------------------------------------------------------------------------
    // Corrections — fact-checker corrections on signals
    // -------------------------------------------------------------------------

    // GET /corrections — list all corrections, optionally filtered by status (Publisher-only)
    this.router.get("/corrections", (c) => {
      const btcAddress = c.req.query("btc_address") ?? "";
      const publisherCheck = verifyPublisher(this.ctx.storage.sql, btcAddress);
      if (!publisherCheck.ok) {
        return c.json({ ok: false, error: publisherCheck.error } satisfies DOResult<Correction[]>, publisherCheck.status);
      }

      const status = c.req.query("status") ?? null;
      const validStatuses = ["pending", "approved", "rejected"];
      if (status && !validStatuses.includes(status)) {
        return c.json(
          { ok: false, error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` } satisfies DOResult<Correction[]>,
          400
        );
      }

      const rows = status
        ? this.ctx.storage.sql
            .exec(
              "SELECT * FROM corrections WHERE status = ? ORDER BY created_at DESC LIMIT 500",
              status
            )
            .toArray()
        : this.ctx.storage.sql
            .exec("SELECT * FROM corrections ORDER BY created_at DESC LIMIT 500")
            .toArray();

      return c.json({ ok: true, data: rows as unknown as Correction[] } satisfies DOResult<Correction[]>);
    });

    // POST /corrections — file a correction
    this.router.post("/corrections", async (c) => {
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json({ ok: false, error: "Invalid JSON body" } satisfies DOResult<Correction>, 400);
      }

      const { signal_id, btc_address, claim, correction, sources } = body;
      if (!signal_id || !btc_address || !claim || !correction) {
        return c.json({
          ok: false,
          error: "Missing required fields: signal_id, btc_address, claim, correction",
        } satisfies DOResult<Correction>, 400);
      }

      // Verify signal exists
      const sigRows = this.ctx.storage.sql
        .exec("SELECT id, status FROM signals WHERE id = ?", signal_id as string)
        .toArray();
      if (sigRows.length === 0) {
        return c.json({ ok: false, error: `Signal "${signal_id}" not found` } satisfies DOResult<Correction>, 404);
      }

      // Can't correct your own signal
      const sigAddr = this.ctx.storage.sql
        .exec("SELECT btc_address FROM signals WHERE id = ?", signal_id as string)
        .toArray();
      if (sigAddr.length > 0 && (sigAddr[0] as Record<string, unknown>).btc_address === btc_address) {
        return c.json({ ok: false, error: "Cannot file a correction on your own signal" } satisfies DOResult<Correction>, 400);
      }

      const id = generateId();
      const now = new Date().toISOString();

      this.ctx.storage.sql.exec(
        `INSERT INTO corrections (id, signal_id, btc_address, claim, correction, sources, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        id,
        signal_id as string,
        btc_address as string,
        sanitizeString(claim, 500),
        sanitizeString(correction, 500),
        sources ? sanitizeString(sources, 1000) : null,
        now
      );

      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM corrections WHERE id = ?", id)
        .toArray();

      return c.json({ ok: true, data: rows[0] as unknown as Correction } satisfies DOResult<Correction>, 201);
    });

    // GET /corrections/signal/:signalId — list corrections for a signal
    this.router.get("/corrections/signal/:signalId", (c) => {
      const signalId = c.req.param("signalId");
      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM corrections WHERE signal_id = ? ORDER BY created_at DESC", signalId)
        .toArray();
      return c.json({ ok: true, data: rows as unknown as Correction[] } satisfies DOResult<Correction[]>);
    });

    // PATCH /corrections/:id — Publisher reviews a correction
    this.router.patch("/corrections/:id", async (c) => {
      const id = c.req.param("id");
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json({ ok: false, error: "Invalid JSON body" } satisfies DOResult<Correction>, 400);
      }

      const { btc_address, status } = body;

      // Verify publisher
      const publisherRows = this.ctx.storage.sql
        .exec("SELECT value FROM config WHERE key = ?", CONFIG_PUBLISHER_ADDRESS)
        .toArray();
      if (publisherRows.length === 0) {
        return c.json({ ok: false, error: "Publisher not yet designated" } satisfies DOResult<Correction>, 403);
      }
      if (btc_address !== (publisherRows[0] as { value: string }).value) {
        return c.json({ ok: false, error: "Only the designated Publisher can review corrections" } satisfies DOResult<Correction>, 403);
      }

      if (!status || (status !== "approved" && status !== "rejected")) {
        return c.json({ ok: false, error: "Status must be 'approved' or 'rejected'" } satisfies DOResult<Correction>, 400);
      }

      // Verify correction exists
      const corrRows = this.ctx.storage.sql
        .exec("SELECT * FROM corrections WHERE id = ?", id)
        .toArray();
      if (corrRows.length === 0) {
        return c.json({ ok: false, error: `Correction "${id}" not found` } satisfies DOResult<Correction>, 404);
      }

      const now = new Date().toISOString();
      this.ctx.storage.sql.exec(
        "UPDATE corrections SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
        status as string,
        btc_address as string,
        now,
        id
      );

      const updated = this.ctx.storage.sql
        .exec("SELECT * FROM corrections WHERE id = ?", id)
        .toArray();

      return c.json({ ok: true, data: updated[0] as unknown as Correction } satisfies DOResult<Correction>);
    });

    // GET /corrections/counts — approved correction counts per address (30-day rolling)
    this.router.get("/corrections/counts", (c) => {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT btc_address, COUNT(*) as correction_count
           FROM corrections
           WHERE status = 'approved' AND created_at > datetime('now', '-30 days')
           GROUP BY btc_address
           ORDER BY correction_count DESC`
        )
        .toArray();
      return c.json({ ok: true, data: rows } satisfies DOResult<unknown[]>);
    });

    // -------------------------------------------------------------------------
    // Referral Credits — scout referral tracking
    // -------------------------------------------------------------------------

    // POST /referrals — register a referral
    this.router.post("/referrals", async (c) => {
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json({ ok: false, error: "Invalid JSON body" } satisfies DOResult<ReferralCredit>, 400);
      }

      const { scout_address, recruit_address } = body;
      if (!scout_address || !recruit_address) {
        return c.json({
          ok: false,
          error: "Missing required fields: scout_address, recruit_address",
        } satisfies DOResult<ReferralCredit>, 400);
      }

      if (scout_address === recruit_address) {
        return c.json({ ok: false, error: "Cannot refer yourself" } satisfies DOResult<ReferralCredit>, 400);
      }

      // Check for duplicate referral
      const existing = this.ctx.storage.sql
        .exec(
          "SELECT id FROM referral_credits WHERE scout_address = ? AND recruit_address = ?",
          scout_address as string,
          recruit_address as string
        )
        .toArray();
      if (existing.length > 0) {
        return c.json({ ok: false, error: "Referral already registered" } satisfies DOResult<ReferralCredit>, 409);
      }

      const id = generateId();
      const now = new Date().toISOString();

      this.ctx.storage.sql.exec(
        `INSERT INTO referral_credits (id, scout_address, recruit_address, created_at)
         VALUES (?, ?, ?, ?)`,
        id,
        scout_address as string,
        recruit_address as string,
        now
      );

      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM referral_credits WHERE id = ?", id)
        .toArray();

      return c.json({ ok: true, data: rows[0] as unknown as ReferralCredit } satisfies DOResult<ReferralCredit>, 201);
    });

    // POST /referrals/credit — credit a referral when recruit files first signal
    this.router.post("/referrals/credit", async (c) => {
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json({ ok: false, error: "Invalid JSON body" } satisfies DOResult<unknown>, 400);
      }

      const { recruit_address, signal_id } = body;
      if (!recruit_address || !signal_id) {
        return c.json({ ok: false, error: "Missing required fields: recruit_address, signal_id" } satisfies DOResult<unknown>, 400);
      }

      // Find uncredited referral for this recruit
      const refRows = this.ctx.storage.sql
        .exec(
          "SELECT * FROM referral_credits WHERE recruit_address = ? AND credited_at IS NULL",
          recruit_address as string
        )
        .toArray();
      if (refRows.length === 0) {
        return c.json({ ok: true, data: { credited: false, reason: "No pending referral for this address" } } satisfies DOResult<unknown>);
      }

      const now = new Date().toISOString();
      this.ctx.storage.sql.exec(
        "UPDATE referral_credits SET credited_at = ?, first_signal_id = ? WHERE recruit_address = ? AND credited_at IS NULL",
        now,
        signal_id as string,
        recruit_address as string
      );

      return c.json({ ok: true, data: { credited: true, recruit_address, signal_id } } satisfies DOResult<unknown>);
    });

    // GET /referrals/counts — referral credit counts per scout (30-day rolling)
    this.router.get("/referrals/counts", (c) => {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT scout_address, COUNT(*) as referral_count
           FROM referral_credits
           WHERE credited_at IS NOT NULL AND credited_at > datetime('now', '-30 days')
           GROUP BY scout_address
           ORDER BY referral_count DESC`
        )
        .toArray();
      return c.json({ ok: true, data: rows } satisfies DOResult<unknown[]>);
    });

    // -------------------------------------------------------------------------
    // Leaderboard v2 — weighted scoring with 30-day rolling window
    // -------------------------------------------------------------------------

    // GET /correspondents-bundle — correspondents + beats + leaderboard in a single DO call.
    // Eliminates 3 separate HTTP round-trips from the Worker route, which serialize
    // inside the DO anyway. Returns all data the correspondents route needs.
    this.router.get("/correspondents-bundle", (c) => {
      const correspondents = this.ctx.storage.sql
        .exec(
          `SELECT s.btc_address,
                  COUNT(s.id) as signal_count,
                  MAX(s.created_at) as last_signal,
                  COUNT(DISTINCT date(s.created_at)) as days_active,
                  st.current_streak,
                  st.longest_streak,
                  st.total_signals,
                  st.last_signal_date
           FROM signals s
           LEFT JOIN streaks st ON s.btc_address = st.btc_address
           WHERE s.correction_of IS NULL
           GROUP BY s.btc_address
           ORDER BY signal_count DESC
           LIMIT 200`
        )
        .toArray();

      const beats = this.ctx.storage.sql
        .exec(
          `SELECT b.*, MAX(s.created_at) as last_signal_at
           FROM beats b
           LEFT JOIN beat_claims bc ON b.slug = bc.beat_slug AND bc.status = 'active'
           LEFT JOIN signals s ON bc.btc_address = s.btc_address
             AND s.beat_slug = b.slug
             AND s.correction_of IS NULL
           GROUP BY b.slug
           ORDER BY b.name`
        )
        .toArray();

      // Fetch active claims for buildBeatsByAddress
      const claims = this.ctx.storage.sql
        .exec(
          `SELECT beat_slug, btc_address, claimed_at FROM beat_claims WHERE status = 'active'`
        )
        .toArray();

      // Leaderboard — wrapped in try/catch so a leaderboard failure
      // doesn't break the correspondents endpoint (preserves old .catch(() => []) behavior)
      let leaderboard: Array<Record<string, unknown>> = [];
      try {
        leaderboard = this.queryLeaderboard(200);
      } catch (e) {
        console.error("Leaderboard query failed in correspondents bundle:", e);
      }

      return c.json({
        ok: true,
        data: { correspondents, beats, claims, leaderboard },
      } satisfies DOResult<{ correspondents: unknown[]; beats: unknown[]; claims: unknown[]; leaderboard: unknown[] }>);
    });

    // GET /init — all data needed for the initial page load in a single DO call.
    // Replaces 5+ separate HTTP round-trips (brief, beats, classifieds, correspondents,
    // front-page signals) with one synchronous pass through SQLite.
    this.router.get("/init", (c) => {
      // Brief
      const briefRows = this.ctx.storage.sql
        .exec("SELECT * FROM briefs ORDER BY date DESC LIMIT 1")
        .toArray();
      const latestBrief = briefRows.length > 0 ? (briefRows[0] as unknown as Brief) : null;

      const briefDateRows = this.ctx.storage.sql
        .exec("SELECT date FROM briefs ORDER BY date DESC")
        .toArray();
      const briefDates = briefDateRows.map((r) => (r as { date: string }).date);

      // Beats (with status computation via beat_claims)
      const beatRows = this.ctx.storage.sql
        .exec(
          `SELECT b.*, MAX(s.created_at) as last_signal_at
           FROM beats b
           LEFT JOIN beat_claims bc ON b.slug = bc.beat_slug AND bc.status = 'active'
           LEFT JOIN signals s ON bc.btc_address = s.btc_address
             AND s.beat_slug = b.slug
             AND s.correction_of IS NULL
           GROUP BY b.slug
           ORDER BY b.name`
        )
        .toArray();

      // Fetch active claims for buildBeatsByAddress
      const claimRows = this.ctx.storage.sql
        .exec(
          `SELECT beat_slug, btc_address, claimed_at FROM beat_claims WHERE status = 'active'`
        )
        .toArray();

      const expiryMs = BEAT_EXPIRY_DAYS * 24 * 3600 * 1000;
      const now = Date.now();
      const beats = beatRows.map((r) => {
        const row = r as Record<string, unknown>;
        const lastSignalAt = row.last_signal_at as string | null;
        const status: "active" | "inactive" =
          lastSignalAt && now - new Date(lastSignalAt).getTime() < expiryMs
            ? "active"
            : "inactive";
        return {
          slug: row.slug,
          name: row.name,
          description: row.description,
          color: row.color,
          created_by: row.created_by,
          created_at: row.created_at,
          updated_at: row.updated_at,
          status,
        } as Beat;
      });

      // Classifieds (active approved only)
      const classifiedRows = this.ctx.storage.sql
        .exec(
          `SELECT * FROM classifieds
           WHERE expires_at > datetime('now')
             AND status = 'approved'
           ORDER BY created_at DESC
           LIMIT 50`
        )
        .toArray() as unknown as Classified[];

      // Correspondents
      const correspondentRows = this.ctx.storage.sql
        .exec(
          `SELECT s.btc_address,
                  COUNT(s.id) as signal_count,
                  MAX(s.created_at) as last_signal,
                  COUNT(DISTINCT date(s.created_at)) as days_active,
                  st.current_streak,
                  st.longest_streak,
                  st.total_signals,
                  st.last_signal_date
           FROM signals s
           LEFT JOIN streaks st ON s.btc_address = st.btc_address
           WHERE s.correction_of IS NULL
           GROUP BY s.btc_address
           ORDER BY signal_count DESC
           LIMIT 200`
        )
        .toArray();

      // Leaderboard — wrapped in try/catch to preserve partial results on failure
      let leaderboard: Array<Record<string, unknown>> = [];
      try {
        leaderboard = this.queryLeaderboard(200);
      } catch (e) {
        console.error("Leaderboard query failed in init bundle:", e);
      }

      // Front-page signals (approved + brief_included)
      const signalRows = this.ctx.storage.sql
        .exec(
          `SELECT s.*, b.name as beat_name, GROUP_CONCAT(st.tag) as tags_csv
           FROM signals s
           LEFT JOIN beats b ON s.beat_slug = b.slug
           LEFT JOIN signal_tags st ON s.id = st.signal_id
           WHERE s.status IN ('approved', 'brief_included')
           GROUP BY s.id
           ORDER BY s.created_at DESC
           LIMIT 500`
        )
        .toArray();
      const signals = signalRows.map((r) => rowToSignal(r as Record<string, unknown>));

      return c.json({
        ok: true,
        data: {
          brief: latestBrief,
          briefDates,
          beats,
          claims: claimRows,
          classifieds: classifiedRows,
          correspondents: correspondentRows,
          leaderboard,
          signals,
        },
      });
    });

    // GET /leaderboard — weighted scores across all roles
    this.router.get("/leaderboard", (c) => {
      const rows = this.queryLeaderboard(200);
      return c.json({ ok: true, data: rows } satisfies DOResult<unknown[]>);
    });

    // -------------------------------------------------------------------------
    // Audit infrastructure — per-address verify and snapshots
    // -------------------------------------------------------------------------

    // GET /leaderboard/verify/:address — public endpoint: verify a scout's score
    // Reuses queryLeaderboard() so scoring math and tie-breaking are always consistent.
    this.router.get("/leaderboard/verify/:address", (c) => {
      const address = c.req.param("address");

      // Single query: get the full ranked leaderboard, then find the target address.
      // This guarantees rank uses the same 4-level tie-breaking as prize payouts.
      const allEntries = this.queryLeaderboard(10_000);
      const idx = allEntries.findIndex(
        (e) => (e as Record<string, unknown>).btc_address === address
      );

      if (idx === -1) {
        return c.json({ ok: false, error: "Address not found on leaderboard" } satisfies DOResult<unknown>, 404);
      }

      const row = allEntries[idx] as Record<string, unknown>;
      const brief_inclusions = Number(row.brief_inclusions_30d);
      const signal_count = Number(row.signal_count_30d);
      const current_streak = Number(row.current_streak);
      const days_active = Number(row.days_active_30d);
      const approved_corrections = Number(row.approved_corrections_30d);
      const referral_credits = Number(row.referral_credits_30d);
      const total_score = Number(row.score);

      return c.json({
        ok: true,
        data: {
          address,
          components: {
            brief_inclusions_30d: brief_inclusions,
            signal_count_30d: signal_count,
            current_streak,
            days_active_30d: days_active,
            approved_corrections_30d: approved_corrections,
            referral_credits_30d: referral_credits,
          },
          component_scores: {
            brief_inclusions: brief_inclusions * SCORING_WEIGHTS.brief_inclusions,
            signal_count: signal_count * SCORING_WEIGHTS.signal_count,
            current_streak: current_streak * SCORING_WEIGHTS.current_streak,
            days_active: days_active * SCORING_WEIGHTS.days_active,
            approved_corrections: approved_corrections * SCORING_WEIGHTS.approved_corrections,
            referral_credits: referral_credits * SCORING_WEIGHTS.referral_credits,
          },
          total_score,
          rank: idx + 1,
        },
      } satisfies DOResult<unknown>);
    });

    // GET /leaderboard/snapshots — list stored snapshots (id, type, week, created_at — NOT full data)
    this.router.get("/leaderboard/snapshots", (c) => {
      const btcAddress = c.req.query("btc_address") ?? "";
      const auth = verifyPublisher(this.ctx.storage.sql, btcAddress);
      if (!auth.ok) {
        return c.json({ ok: false, error: auth.error } satisfies DOResult<unknown>, auth.status);
      }
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT id, snapshot_type, week, created_at
           FROM leaderboard_snapshots
           ORDER BY created_at DESC`
        )
        .toArray();
      return c.json({ ok: true, data: rows } satisfies DOResult<unknown[]>);
    });

    // GET /leaderboard/snapshots/:id — retrieve a specific snapshot with full data
    this.router.get("/leaderboard/snapshots/:id", (c) => {
      const btcAddress = c.req.query("btc_address") ?? "";
      const auth = verifyPublisher(this.ctx.storage.sql, btcAddress);
      if (!auth.ok) {
        return c.json({ ok: false, error: auth.error } satisfies DOResult<unknown>, auth.status);
      }
      const id = c.req.param("id");
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT id, snapshot_type, week, snapshot_data, created_at
           FROM leaderboard_snapshots
           WHERE id = ?`,
          id
        )
        .toArray();
      if (rows.length === 0) {
        return c.json({ ok: false, error: "Snapshot not found" } satisfies DOResult<unknown>, 404);
      }
      const row = rows[0] as Record<string, unknown>;
      return c.json({
        ok: true,
        data: {
          id: row.id,
          snapshot_type: row.snapshot_type,
          week: row.week,
          snapshot_data: JSON.parse(row.snapshot_data as string),
          created_at: row.created_at,
        },
      } satisfies DOResult<unknown>);
    });

    // POST /leaderboard/reset — Publisher-only: snapshot leaderboard, clear 5 scoring tables, prune old snapshots
    // Preserves all signal history. Prunes snapshots to keep only the 10 most recent.
    this.router.post("/leaderboard/reset", async (c) => {
      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json({ ok: false, error: "Invalid JSON body" } satisfies DOResult<unknown>, 400);
      }

      const { btc_address } = body as { btc_address?: unknown };
      if (typeof btc_address !== "string") {
        return c.json({ ok: false, error: "btc_address is required and must be a string" } satisfies DOResult<unknown>, 400);
      }

      const pub = verifyPublisher(this.ctx.storage.sql, btc_address);
      if (!pub.ok) {
        return c.json({ ok: false, error: pub.error } satisfies DOResult<unknown>, pub.status);
      }

      const now = new Date().toISOString();
      const snapshotId = generateId();

      // Snapshot the full leaderboard before clearing scoring tables.
      const allEntries = this.queryLeaderboard(10_000);
      try {
        this.ctx.storage.sql.exec(
          `INSERT INTO leaderboard_snapshots (id, snapshot_type, week, snapshot_data, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          snapshotId,
          "launch_reset",
          null,
          JSON.stringify(allEntries),
          now
        );
      } catch (e) {
        console.error("Failed to save launch_reset snapshot:", e);
        return c.json({ ok: false, error: "Failed to create snapshot before reset" } satisfies DOResult<unknown>, 500);
      }

      // Delete rows from each of the 5 scoring tables, preserving signal history.
      try {
        const briefSignalsCursor = this.ctx.storage.sql.exec("DELETE FROM brief_signals");
        const streaksCursor = this.ctx.storage.sql.exec("DELETE FROM streaks");
        const correctionsCursor = this.ctx.storage.sql.exec("DELETE FROM corrections");
        const referralCreditsCursor = this.ctx.storage.sql.exec("DELETE FROM referral_credits");
        const earningsCursor = this.ctx.storage.sql.exec("DELETE FROM earnings");

        // Prune snapshots to keep only the 10 most recent by created_at DESC.
        const pruneCursor = this.ctx.storage.sql.exec(
          `DELETE FROM leaderboard_snapshots
           WHERE id NOT IN (
             SELECT id FROM leaderboard_snapshots
             ORDER BY created_at DESC
             LIMIT 10
           )`
        );

        return c.json({
          ok: true,
          data: {
            snapshot_id: snapshotId,
            deleted: {
              brief_signals: briefSignalsCursor.rowsWritten,
              streaks: streaksCursor.rowsWritten,
              corrections: correctionsCursor.rowsWritten,
              referral_credits: referralCreditsCursor.rowsWritten,
              earnings: earningsCursor.rowsWritten,
            },
            pruned_snapshots: pruneCursor.rowsWritten,
          },
        } satisfies DOResult<unknown>);
      } catch (e) {
        console.error("Failed to reset leaderboard scoring tables:", e);
        return c.json({ ok: false, error: "Failed to reset leaderboard scoring tables" } satisfies DOResult<unknown>, 500);
      }
    });

    // -------------------------------------------------------------------------
    // Test-only seed endpoint — NOT available in production
    // Allows integration tests to insert rows with arbitrary timestamps so that
    // exact scoring math can be verified without fighting rate-limit constraints.
    // -------------------------------------------------------------------------
    this.router.post("/test-seed", async (c) => {
      // Hard gate: refuse to serve this route in production
      if (this.env.ENVIRONMENT !== "test" && this.env.ENVIRONMENT !== "development") {
        return c.json({ ok: false, error: "Not found" }, 404);
      }

      const body = await parseRequiredJson(c);
      if (!body) {
        return c.json({ ok: false, error: "Invalid JSON body" }, 400);
      }

      const inserted: Record<string, number> = {
        signals: 0,
        brief_signals: 0,
        corrections: 0,
        referral_credits: 0,
        streaks: 0,
        leaderboard_snapshots: 0,
      };

      // Seed signals
      if (Array.isArray(body.signals)) {
        for (const row of body.signals as Array<Record<string, unknown>>) {
          try {
            this.ctx.storage.sql.exec(
              `INSERT OR IGNORE INTO signals
               (id, beat_slug, btc_address, headline, body, sources, created_at, updated_at,
                correction_of, status, disclosure)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              row.id as string,
              row.beat_slug as string,
              row.btc_address as string,
              row.headline as string,
              (row.body as string | null) ?? null,
              (row.sources as string) ?? "[]",
              row.created_at as string,
              row.created_at as string,
              (row.correction_of as string | null) ?? null,
              (row.status as string) ?? "submitted",
              (row.disclosure as string) ?? ""
            );
            inserted.signals++;
          } catch {
            // Skip invalid rows silently
          }
        }
      }

      // Seed brief_signals (requires corresponding signals to exist for btc_address lookup)
      if (Array.isArray(body.brief_signals)) {
        for (const row of body.brief_signals as Array<Record<string, unknown>>) {
          try {
            this.ctx.storage.sql.exec(
              `INSERT OR IGNORE INTO brief_signals
               (brief_date, signal_id, btc_address, position, created_at)
               VALUES (?, ?, ?, ?, ?)`,
              row.brief_date as string,
              row.signal_id as string,
              row.btc_address as string,
              (row.position as number) ?? 0,
              row.created_at as string
            );
            inserted.brief_signals++;
          } catch {
            // Skip invalid rows silently
          }
        }
      }

      // Seed corrections
      if (Array.isArray(body.corrections)) {
        for (const row of body.corrections as Array<Record<string, unknown>>) {
          try {
            this.ctx.storage.sql.exec(
              `INSERT OR IGNORE INTO corrections
               (id, signal_id, btc_address, claim, correction, sources, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              row.id as string,
              row.signal_id as string,
              row.btc_address as string,
              (row.claim as string) ?? "test claim",
              (row.correction as string) ?? "test correction",
              (row.sources as string | null) ?? null,
              (row.status as string) ?? "approved",
              row.created_at as string
            );
            inserted.corrections++;
          } catch {
            // Skip invalid rows silently
          }
        }
      }

      // Seed referral_credits
      if (Array.isArray(body.referral_credits)) {
        for (const row of body.referral_credits as Array<Record<string, unknown>>) {
          try {
            this.ctx.storage.sql.exec(
              `INSERT OR IGNORE INTO referral_credits
               (id, scout_address, recruit_address, credited_at, created_at)
               VALUES (?, ?, ?, ?, ?)`,
              row.id as string,
              row.scout_address as string,
              row.recruit_address as string,
              row.credited_at as string,
              row.created_at as string
            );
            inserted.referral_credits++;
          } catch {
            // Skip invalid rows silently
          }
        }
      }

      // Seed streaks
      if (Array.isArray(body.streaks)) {
        for (const row of body.streaks as Array<Record<string, unknown>>) {
          try {
            this.ctx.storage.sql.exec(
              `INSERT OR REPLACE INTO streaks
               (btc_address, current_streak, longest_streak, last_signal_date, total_signals)
               VALUES (?, ?, ?, ?, ?)`,
              row.btc_address as string,
              (row.current_streak as number) ?? 0,
              (row.longest_streak as number) ?? 0,
              (row.last_signal_date as string | null) ?? null,
              (row.total_signals as number) ?? 0
            );
            inserted.streaks++;
          } catch {
            // Skip invalid rows silently
          }
        }
      }

      // Seed leaderboard_snapshots (used to test scoring epoch after reset)
      if (Array.isArray(body.leaderboard_snapshots)) {
        for (const row of body.leaderboard_snapshots as Array<Record<string, unknown>>) {
          try {
            this.ctx.storage.sql.exec(
              `INSERT OR IGNORE INTO leaderboard_snapshots
               (id, snapshot_type, week, snapshot_data, created_at)
               VALUES (?, ?, ?, ?, ?)`,
              row.id as string,
              (row.snapshot_type as string) ?? "launch_reset",
              (row.week as string | null) ?? null,
              (row.snapshot_data as string) ?? "[]",
              row.created_at as string
            );
            inserted.leaderboard_snapshots++;
          } catch {
            // Skip invalid rows silently
          }
        }
      }

      // Seed config (publisher designation, etc.)
      if (Array.isArray(body.config)) {
        for (const row of body.config as Array<Record<string, unknown>>) {
          try {
            this.ctx.storage.sql.exec(
              `INSERT INTO config (key, value, updated_at)
               VALUES (?, ?, datetime('now'))
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
              row.key as string,
              row.value as string
            );
          } catch {
            // Skip invalid rows silently
          }
        }
      }

      // Seed briefs
      if (Array.isArray(body.briefs)) {
        for (const row of body.briefs as Array<Record<string, unknown>>) {
          try {
            this.ctx.storage.sql.exec(
              `INSERT OR REPLACE INTO briefs (date, text, json_data, compiled_at, inscribed_txid, inscription_id)
               VALUES (?, ?, ?, ?, ?, ?)`,
              row.date as string,
              (row.text as string) ?? "",
              (row.json_data as string) ?? "{}",
              (row.compiled_at as string) ?? new Date().toISOString(),
              (row.inscribed_txid as string | null) ?? null,
              (row.inscription_id as string | null) ?? null
            );
          } catch {
            // Skip invalid rows silently
          }
        }
      }

      // Seed earnings
      if (Array.isArray(body.earnings)) {
        for (const row of body.earnings as Array<Record<string, unknown>>) {
          try {
            this.ctx.storage.sql.exec(
              `INSERT OR IGNORE INTO earnings (id, btc_address, amount_sats, reason, reference_id, created_at, payout_txid)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              row.id as string,
              row.btc_address as string,
              (row.amount_sats as number) ?? 0,
              (row.reason as string) ?? "brief_inclusion",
              (row.reference_id as string | null) ?? null,
              (row.created_at as string) ?? new Date().toISOString(),
              (row.payout_txid as string | null) ?? null
            );
          } catch {
            // Skip invalid rows silently
          }
        }
      }

      return c.json({ ok: true, data: { inserted } });
    });

    this.router.all("*", (c) => {
      return c.json({ ok: false, error: "Not found" }, 404);
    });
  }

  /**
   * Shared leaderboard scoring query — used by GET /leaderboard and POST /payouts/weekly.
   *
   * Multipliers below correspond to SCORING_WEIGHTS in src/lib/constants.ts.
   * Update both places when changing weights. SQL literals are used directly
   * because SQLite bind parameters cannot substitute column expressions.
   *
   * ── Scoring timeline (Pacific time) ──────────────────────────────────────
   * This system is operated by a Pacific-based publisher. All streak and day
   * boundaries use Pacific time (America/Los_Angeles), so a scout's "day" runs
   * midnight-to-midnight PT regardless of UTC offset.
   *
   * Daily editorial cycle:
   *   - Scouts file signals any time during the Pacific day.
   *   - The publisher compiles the brief at ~11 pm PT each night.
   *   - Signals approved before the 11 pm PT cutoff are eligible for that
   *     day's brief inclusion (brief_inclusions_30d).
   *   - Streak logic (in POST /signals) uses getPacificDate() / getPacificYesterday()
   *     to determine whether today or yesterday (Pacific) already has a signal.
   *
   * Rolling window:
   *   - signal_count, days_active, approved_corrections, and referral_credits
   *     all use datetime('now', '-30 days') which is UTC-based.
   *   - brief_inclusions uses the same UTC window on brief_signals.created_at.
   *   - Streaks are NOT windowed — current_streak reflects unbroken consecutive
   *     Pacific days up to the most recent signal, regardless of the 30-day limit.
   *
   * ── Tie-breaking order ────────────────────────────────────────────────────
   * To ensure the leaderboard is fully deterministic (critical for prize payouts):
   *   1. score DESC            — highest weighted score wins
   *   2. current_streak DESC   — longest current streak breaks score ties
   *   3. first_signal_at ASC   — earliest ever signal (longest tenure) breaks streak ties
   *   4. btc_address ASC       — alphabetical fallback; always unique
   */
  private queryLeaderboard(limit: number): Array<Record<string, unknown>> {
    // SQL literals mirror SCORING_WEIGHTS; tests assert exact scores to enforce sync.
    //
    // The `epoch` CTE derives the scoring epoch from the most recent launch_reset
    // snapshot. Signals filed before the epoch are excluded from signal_count and
    // days_active so that a leaderboard reset zeroes all scores even though the
    // signals table is intentionally preserved for historical record. Tables that
    // are fully cleared on reset (brief_signals, streaks, corrections,
    // referral_credits, earnings) do not need epoch filtering.
    return this.ctx.storage.sql
      .exec(
        `WITH epoch AS (
           SELECT COALESCE(
             (SELECT created_at FROM leaderboard_snapshots
              WHERE snapshot_type = 'launch_reset'
              ORDER BY created_at DESC LIMIT 1),
             '1970-01-01T00:00:00.000Z'
           ) AS ts
         )
         SELECT
           a.btc_address,
           COALESCE(bi.inclusion_count, 0) as brief_inclusions_30d,
           COALESCE(sc.signal_count, 0) as signal_count_30d,
           COALESCE(st.current_streak, 0) as current_streak,
           COALESCE(da.days_active, 0) as days_active_30d,
           COALESCE(cr.correction_count, 0) as approved_corrections_30d,
           COALESCE(rf.referral_count, 0) as referral_credits_30d,
           COALESCE(ea.total_earned_sats, 0) as total_earned_sats,
           (COALESCE(bi.inclusion_count, 0) * 20  /* SCORING_WEIGHTS.brief_inclusions */
            + COALESCE(sc.signal_count, 0) * 5    /* SCORING_WEIGHTS.signal_count */
            + COALESCE(st.current_streak, 0) * 5  /* SCORING_WEIGHTS.current_streak */
            + COALESCE(da.days_active, 0) * 2     /* SCORING_WEIGHTS.days_active */
            + COALESCE(cr.correction_count, 0) * 15  /* SCORING_WEIGHTS.approved_corrections */
            + COALESCE(rf.referral_count, 0) * 25) as score  /* SCORING_WEIGHTS.referral_credits */
         FROM (
           SELECT DISTINCT btc_address FROM signals
           WHERE correction_of IS NULL
             AND created_at > (SELECT ts FROM epoch)
         ) a
         LEFT JOIN (
           SELECT btc_address, COUNT(*) as inclusion_count
           FROM brief_signals WHERE created_at > datetime('now', '-30 days') AND retracted_at IS NULL
           GROUP BY btc_address
         ) bi ON a.btc_address = bi.btc_address
         LEFT JOIN (
           SELECT btc_address, COUNT(*) as signal_count
           FROM signals
           WHERE correction_of IS NULL
             AND created_at > datetime('now', '-30 days')
             AND created_at > (SELECT ts FROM epoch)
           GROUP BY btc_address
         ) sc ON a.btc_address = sc.btc_address
         LEFT JOIN streaks st ON a.btc_address = st.btc_address
         LEFT JOIN (
           SELECT btc_address, COUNT(DISTINCT date(created_at)) as days_active
           FROM signals
           WHERE correction_of IS NULL
             AND created_at > datetime('now', '-30 days')
             AND created_at > (SELECT ts FROM epoch)
           GROUP BY btc_address
         ) da ON a.btc_address = da.btc_address
         LEFT JOIN (
           SELECT btc_address, COUNT(*) as correction_count
           FROM corrections WHERE status = 'approved' AND created_at > datetime('now', '-30 days')
           GROUP BY btc_address
         ) cr ON a.btc_address = cr.btc_address
         LEFT JOIN (
           SELECT scout_address as btc_address, COUNT(*) as referral_count
           FROM referral_credits WHERE credited_at IS NOT NULL AND credited_at > datetime('now', '-30 days')
           GROUP BY scout_address
         ) rf ON a.btc_address = rf.btc_address
         LEFT JOIN (
           -- Lifetime cumulative earnings (positive amounts only; not windowed to 30 days).
           SELECT btc_address, SUM(amount_sats) AS total_earned_sats
           FROM earnings WHERE amount_sats > 0 AND voided_at IS NULL
           GROUP BY btc_address
         ) ea ON a.btc_address = ea.btc_address
         LEFT JOIN (
           -- Earliest-ever non-correction signal per scout — used as tenure tie-breaker.
           -- Not windowed: a scout who joined 2 years ago always beats a newcomer with the same score.
           SELECT btc_address, MIN(created_at) AS first_signal_at
           FROM signals WHERE correction_of IS NULL
           GROUP BY btc_address
         ) fs ON a.btc_address = fs.btc_address
         -- 4-level deterministic tie-breaking for competition fairness:
         --   1. score DESC          — highest score wins
         --   2. current_streak DESC — longest active streak breaks score ties
         --   3. first_signal_at ASC — earliest tenure breaks streak ties (COALESCE to 'z' so NULLs sort last)
         --   4. btc_address ASC     — alphabetical fallback; always unique
         ORDER BY score DESC, COALESCE(st.current_streak, 0) DESC, COALESCE(fs.first_signal_at, 'z') ASC, a.btc_address ASC
         LIMIT ?`,
        limit
      )
      .toArray();
  }

  /** Keep-alive alarm — reschedules itself every 50 seconds to prevent DO eviction. */
  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 50_000);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.router.fetch(request);
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "Unknown error" }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
  }
}
