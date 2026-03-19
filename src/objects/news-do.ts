import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, Beat, Signal, SignalStatus, Streak, Brief, Classified, Earning, Correction, ReferralCredit, BriefSignal, CompiledBriefData, DOResult, PayoutRecord } from "../lib/types";
import { validateSlug, validateHexColor, sanitizeString } from "../lib/validators";
import { generateId, getPacificDate, getPacificYesterday, getPacificDayStartUTC, getNextDate } from "../lib/helpers";
import { CLASSIFIED_DURATION_DAYS, SIGNAL_COOLDOWN_HOURS, BEAT_EXPIRY_DAYS, MAX_SIGNALS_PER_DAY, SIGNAL_STATUSES, CONFIG_PUBLISHER_ADDRESS, BRIEF_INCLUSION_PAYOUT_SATS, WEEKLY_PRIZE_1ST_SATS, WEEKLY_PRIZE_2ND_SATS, WEEKLY_PRIZE_3RD_SATS } from "../lib/constants";
import { SCHEMA_SQL, MIGRATION_PHASE0_SQL, MIGRATION_PAYMENTS_SQL, MIGRATION_BEAT_RESTRUCTURE_SQL } from "./schema";

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

    // Run Phase 0 migrations for existing databases (safe to re-run — ALTER TABLE
    // throws "duplicate column" which we catch and ignore).
    for (const stmt of MIGRATION_PHASE0_SQL) {
      try {
        this.ctx.storage.sql.exec(stmt);
      } catch (e) {
        // Column/index already exists — safe to ignore on re-run.
        // Log in case the error is unexpected (e.g. malformed SQL introduced later).
        console.error("Migration statement failed (likely already applied):", e);
      }
    }

    // Run Phase 3 beat-restructure migration as a single exec() call.
    // DO SQLite uses automatic atomic write coalescing — all writes within a
    // single exec() are applied atomically (no manual BEGIN/COMMIT needed).
    // This ensures signal remaps and beat deletes are all-or-nothing.
    // The SQL itself is idempotent, so re-running on a fully-migrated DB is a no-op.
    try {
      this.ctx.storage.sql.exec(MIGRATION_BEAT_RESTRUCTURE_SQL);
    } catch (e) {
      console.error("Beat restructure migration failed:", e);
    }

    // Run Phase 4 payments migration — adds UNIQUE index for double-pay prevention.
    for (const stmt of MIGRATION_PAYMENTS_SQL) {
      try {
        this.ctx.storage.sql.exec(stmt);
      } catch (e) {
        // Index already exists — safe to ignore on re-run.
        console.error("Payments migration statement failed (likely already applied):", e);
      }
    }

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
      // Valid transitions: submitted → in_review → approved/rejected, approved → brief_included
      const currentStatus = (signalRows[0] as { id: string; status: string }).status;
      const VALID_TRANSITIONS: Record<string, string[]> = {
        submitted: ["in_review", "approved", "rejected"],
        in_review: ["approved", "rejected"],
        approved: ["brief_included", "rejected"],
        rejected: ["approved"],
        brief_included: [],
      };
      const allowed = VALID_TRANSITIONS[currentStatus] ?? [];
      if (!allowed.includes(status as string)) {
        return c.json({
          ok: false,
          error: `Invalid transition: "${currentStatus}" → "${status}". Allowed from ${currentStatus}: ${allowed.length ? allowed.join(", ") : "none (terminal state)"}`,
        } satisfies DOResult<Signal>, 400);
      }

      const now = new Date().toISOString();
      this.ctx.storage.sql.exec(
        `UPDATE signals SET status = ?, publisher_feedback = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ?`,
        status as string,
        feedback ? sanitizeString(feedback, 1000) : null,
        now,
        now,
        id
      );

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
           LEFT JOIN signals s ON b.created_by = s.btc_address AND s.correction_of IS NULL
           GROUP BY b.slug
           ORDER BY b.name`
        )
        .toArray();
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
           LEFT JOIN signals s ON b.created_by = s.btc_address AND s.correction_of IS NULL
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
      const beat: Beat = {
        slug: row.slug as string,
        name: row.name as string,
        description: row.description as string | null,
        color: row.color as string | null,
        created_by: row.created_by as string,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
        status,
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

      // Check for existing beat — allow reclaim if inactive
      const existing = this.ctx.storage.sql
        .exec(
          `SELECT b.*, MAX(s.created_at) as last_signal_at
           FROM beats b
           LEFT JOIN signals s ON b.created_by = s.btc_address AND s.correction_of IS NULL
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
        if (isActive) {
          return c.json(
            {
              ok: false,
              error: `Beat "${slug as string}" already exists`,
            } satisfies DOResult<Beat>,
            409
          );
        }
        // Inactive — reclaim: update created_by to new agent
        const now = new Date().toISOString();
        this.ctx.storage.sql.exec(
          "UPDATE beats SET created_by = ?, updated_at = ? WHERE slug = ?",
          created_by as string,
          now,
          slug as string
        );
        const reclaimed = this.ctx.storage.sql
          .exec("SELECT * FROM beats WHERE slug = ?", slug as string)
          .toArray();
        const beat = reclaimed[0] as unknown as Beat;
        return c.json({ ok: true, data: { ...beat, status: "active" as const } } satisfies DOResult<Beat>, 200);
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

      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM beats WHERE slug = ?", beatSlug)
        .toArray();
      const beat = rows[0] as unknown as Beat;

      return c.json({ ok: true, data: beat } satisfies DOResult<Beat>, 201);
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

      const earningId = generateId();

      // Insert signal, tags, streak, and earning as individual statements.
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

      this.ctx.storage.sql.exec(
        `INSERT INTO earnings (id, btc_address, amount_sats, reason, reference_id, created_at)
           VALUES (?, ?, 0, 'signal', ?, ?)`,
        earningId,
        btc_address as string,
        signalId,
        nowIso
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

    // GET /classifieds — list active classifieds
    this.router.get("/classifieds", (c) => {
      const category = c.req.query("category") ?? null;
      const limitParam = c.req.query("limit");
      const limit = Math.min(
        Math.max(1, parseInt(limitParam ?? "20", 10) || 20),
        50
      );
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT * FROM classifieds
           WHERE expires_at > datetime('now')
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

      const { btc_address, category, headline, body: adBody, contact, payment_txid } = body;

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

      // expires_at = now + CLASSIFIED_DURATION_DAYS
      const expiresAt = new Date(now);
      expiresAt.setDate(expiresAt.getDate() + CLASSIFIED_DURATION_DAYS);

      this.ctx.storage.sql.exec(
        `INSERT INTO classifieds (id, btc_address, category, headline, body, contact, payment_txid, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        btc_address as string,
        category as string,
        sanitizeString(headline, 100),
        adBody ? sanitizeString(adBody, 500) : null,
        contact ? sanitizeString(contact, 200) : null,
        payment_txid ? (payment_txid as string) : null,
        nowIso,
        expiresAt.toISOString()
      );

      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM classifieds WHERE id = ?", id)
        .toArray();

      return c.json(
        { ok: true, data: rows[0] as unknown as Classified } satisfies DOResult<Classified>,
        201
      );
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

      // Find agent's beat (created_by = address)
      const beatRows = this.ctx.storage.sql
        .exec(
          `SELECT b.*, MAX(s.created_at) as last_signal_at
           FROM beats b
           LEFT JOIN signals s ON b.created_by = s.btc_address AND s.correction_of IS NULL
           WHERE b.created_by = ?
           GROUP BY b.slug
           LIMIT 1`,
          address
        )
        .toArray();

      let beat: Record<string, unknown> | null = null;
      let beatStatus: "active" | "inactive" | null = null;
      if (beatRows.length > 0) {
        const row = beatRows[0] as Record<string, unknown>;
        beat = {
          slug: row.slug,
          name: row.name,
          description: row.description,
          color: row.color,
          created_by: row.created_by,
          created_at: row.created_at,
          updated_at: row.updated_at,
        };
        const lastSignalAt = row.last_signal_at as string | null;
        const expiryMs = BEAT_EXPIRY_DAYS * 24 * 3600 * 1000;
        beatStatus = lastSignalAt && now.getTime() - new Date(lastSignalAt).getTime() < expiryMs
          ? "active"
          : "inactive";
      }

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

      if (!beat) {
        actions.push({ type: "claim-beat", description: "Claim a news beat to start filing signals" });
      } else if (signalsToday >= MAX_SIGNALS_PER_DAY) {
        canFileSignal = false;
        actions.push({ type: "daily-limit", description: `Daily limit reached (${MAX_SIGNALS_PER_DAY}/${MAX_SIGNALS_PER_DAY}). Try again tomorrow.` });
      } else if (canFileSignal) {
        actions.push({ type: "file-signal", description: `File a signal on your beat "${(beat.name as string)}" (${signalsToday}/${MAX_SIGNALS_PER_DAY} today)` });
      } else if (waitMinutes !== null) {
        actions.push({ type: "wait", description: `Cooldown active — wait ${waitMinutes} minute${waitMinutes === 1 ? "" : "s"}`, waitMinutes });
      }

      if (streak && (streak.current_streak as number) > 0 && !filedToday) {
        actions.push({ type: "maintain-streak", description: "File a signal today to maintain your streak" });
      }

      if (beat && !todayBrief && signalsToday >= 3) {
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

      const top3 = this.queryLeaderboard(3) as Array<{ btc_address: string; score: number }>;

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
           WHERE created_at > datetime('now', '-30 days')
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
           WHERE bs.brief_date = ?
           ORDER BY bs.position`,
          date
        )
        .toArray();
      return c.json({ ok: true, data: rows } satisfies DOResult<unknown[]>);
    });

    // -------------------------------------------------------------------------
    // Corrections — fact-checker corrections on signals
    // -------------------------------------------------------------------------

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

    // GET /leaderboard — weighted scores across all roles
    this.router.get("/leaderboard", (c) => {
      const rows = this.queryLeaderboard(200);
      return c.json({ ok: true, data: rows } satisfies DOResult<unknown[]>);
    });

    this.router.all("*", (c) => {
      return c.json({ ok: false, error: "Not found" }, 404);
    });
  }

  /** Shared leaderboard scoring query — used by GET /leaderboard and POST /payouts/weekly. */
  private queryLeaderboard(limit: number): Array<Record<string, unknown>> {
    return this.ctx.storage.sql
      .exec(
        `SELECT
           a.btc_address,
           COALESCE(bi.inclusion_count, 0) as brief_inclusions_30d,
           COALESCE(sc.signal_count, 0) as signal_count_30d,
           COALESCE(st.current_streak, 0) as current_streak,
           COALESCE(da.days_active, 0) as days_active_30d,
           COALESCE(cr.correction_count, 0) as approved_corrections_30d,
           COALESCE(rf.referral_count, 0) as referral_credits_30d,
           (COALESCE(bi.inclusion_count, 0) * 20
            + COALESCE(sc.signal_count, 0) * 5
            + COALESCE(st.current_streak, 0) * 5
            + COALESCE(da.days_active, 0) * 2
            + COALESCE(cr.correction_count, 0) * 15
            + COALESCE(rf.referral_count, 0) * 25) as score
         FROM (SELECT DISTINCT btc_address FROM signals WHERE correction_of IS NULL) a
         LEFT JOIN (
           SELECT btc_address, COUNT(*) as inclusion_count
           FROM brief_signals WHERE created_at > datetime('now', '-30 days')
           GROUP BY btc_address
         ) bi ON a.btc_address = bi.btc_address
         LEFT JOIN (
           SELECT btc_address, COUNT(*) as signal_count
           FROM signals WHERE correction_of IS NULL AND created_at > datetime('now', '-30 days')
           GROUP BY btc_address
         ) sc ON a.btc_address = sc.btc_address
         LEFT JOIN streaks st ON a.btc_address = st.btc_address
         LEFT JOIN (
           SELECT btc_address, COUNT(DISTINCT date(created_at)) as days_active
           FROM signals WHERE correction_of IS NULL AND created_at > datetime('now', '-30 days')
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
         ORDER BY score DESC, a.btc_address ASC
         LIMIT ?`,
        limit
      )
      .toArray();
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
