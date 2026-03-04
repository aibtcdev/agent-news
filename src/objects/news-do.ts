import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import type { Env, Beat, Signal, Streak, Brief, Classified, Earning, CompiledBriefData, DOResult } from "../lib/types";
import { validateSlug, validateHexColor, sanitizeString } from "../lib/validators";
import { generateId, getPacificDate, getPacificYesterday, getPacificDayStartUTC, getNextDate } from "../lib/helpers";
import { CLASSIFIED_DURATION_DAYS } from "../lib/constants";
import { SCHEMA_SQL } from "./schema";

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

    // Initialize SQLite schema on every construction (idempotent via IF NOT EXISTS)
    this.ctx.storage.sql.exec(SCHEMA_SQL);

    // Internal Hono router for DO-internal routing
    this.router = new Hono();

    this.router.get("/health", (c) => {
      return c.json({ ok: true, migrated: true });
    });

    // -------------------------------------------------------------------------
    // Beats CRUD
    // -------------------------------------------------------------------------

    // GET /beats — list all beats ordered by name
    this.router.get("/beats", (c) => {
      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM beats ORDER BY name")
        .toArray();
      const beats = rows as unknown as Beat[];
      return c.json({ ok: true, data: beats } satisfies DOResult<Beat[]>);
    });

    // GET /beats/:slug — get a single beat by slug
    this.router.get("/beats/:slug", (c) => {
      const slug = c.req.param("slug");
      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM beats WHERE slug = ?", slug)
        .toArray();
      if (rows.length === 0) {
        return c.json(
          { ok: false, error: `Beat "${slug}" not found` } satisfies DOResult<Beat>,
          404
        );
      }
      return c.json({ ok: true, data: rows[0] as unknown as Beat } satisfies DOResult<Beat>);
    });

    // POST /beats — create a new beat
    this.router.post("/beats", async (c) => {
      let body: Record<string, unknown>;
      try {
        body = await c.req.json<Record<string, unknown>>();
      } catch {
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

      // Check for existing beat
      const existing = this.ctx.storage.sql
        .exec("SELECT slug FROM beats WHERE slug = ?", slug as string)
        .toArray();
      if (existing.length > 0) {
        return c.json(
          {
            ok: false,
            error: `Beat "${slug as string}" already exists`,
          } satisfies DOResult<Beat>,
          409
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

      let body: Record<string, unknown>;
      try {
        body = await c.req.json<Record<string, unknown>>();
      } catch {
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

    // GET /signals — list signals with optional filters (beat, agent, tag, since, limit)
    this.router.get("/signals", (c) => {
      const beat = c.req.query("beat") ?? null;
      const agent = c.req.query("agent") ?? null;
      const since = c.req.query("since") ?? null;
      const tag = c.req.query("tag") ?? null;
      const limitParam = c.req.query("limit");
      const limit = Math.min(
        Math.max(1, parseInt(limitParam ?? "50", 10) || 50),
        200
      );

      const rows = this.ctx.storage.sql
        .exec(
          `SELECT s.*, GROUP_CONCAT(st.tag) as tags_csv
           FROM signals s
           LEFT JOIN signal_tags st ON s.id = st.signal_id
           WHERE (?1 IS NULL OR s.beat_slug = ?1)
             AND (?2 IS NULL OR s.btc_address = ?2)
             AND (?3 IS NULL OR s.created_at > ?3)
             AND (?4 IS NULL OR s.id IN (SELECT signal_id FROM signal_tags WHERE tag = ?4))
           GROUP BY s.id
           ORDER BY s.created_at DESC
           LIMIT ?5`,
          beat,
          agent,
          since,
          tag,
          limit
        )
        .toArray();

      const signals = rows.map((r) => {
        const row = r as Record<string, unknown>;
        return {
          ...row,
          sources: typeof row.sources === "string" ? (JSON.parse(row.sources) as unknown[]) : [],
          tags: row.tags_csv ? String(row.tags_csv).split(",") : [],
          tags_csv: undefined,
        } as unknown as Signal;
      });

      return c.json({ ok: true, data: signals } satisfies DOResult<Signal[]>);
    });

    // GET /signals/:id — get a single signal with tags joined
    this.router.get("/signals/:id", (c) => {
      const id = c.req.param("id");
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT s.*, GROUP_CONCAT(st.tag) as tags_csv
           FROM signals s
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

      const row = rows[0] as Record<string, unknown>;
      const signal = {
        ...row,
        sources: typeof row.sources === "string" ? (JSON.parse(row.sources) as unknown[]) : [],
        tags: row.tags_csv ? String(row.tags_csv).split(",") : [],
        tags_csv: undefined,
      } as unknown as Signal;

      return c.json({ ok: true, data: signal } satisfies DOResult<Signal>);
    });

    // POST /signals — atomic insert: signal + tags + streak + earning
    this.router.post("/signals", async (c) => {
      let body: Record<string, unknown>;
      try {
        body = await c.req.json<Record<string, unknown>>();
      } catch {
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

      const now = new Date();
      const nowIso = now.toISOString();
      const signalId = generateId();
      const sourcesJson = JSON.stringify(sources ?? []);
      const sanitizedBody = signalBody ? sanitizeString(signalBody, 1000) : null;
      const signalTags = (tags as string[]) ?? [];

      // Atomic transaction: insert signal + tags + streak + earning
      // All statements executed in one exec block ensures atomicity in SQLite
      const tagInserts = signalTags
        .map(() => `INSERT INTO signal_tags (signal_id, tag) VALUES (?, ?);`)
        .join("\n");
      const tagParams: unknown[] = [];
      for (const t of signalTags) {
        tagParams.push(signalId, t);
      }

      // Streak calculation (Pacific timezone)
      const today = getPacificDate(now);
      const yesterday = getPacificYesterday(now);
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
          // Already filed today (Pacific) — no streak change
          currentStreak = currentStreakRecord.current_streak ?? 1;
          longestStreak = currentStreakRecord.longest_streak ?? 1;
          totalSignals = currentStreakRecord.total_signals ?? 1; // don't double-count
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

      // Execute everything atomically
      this.ctx.storage.sql.exec(
        `BEGIN;
         INSERT INTO signals (id, beat_slug, btc_address, headline, body, sources, created_at, updated_at, correction_of)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL);
         ${tagInserts}
         INSERT OR REPLACE INTO streaks (btc_address, current_streak, longest_streak, last_signal_date, total_signals)
           VALUES (?, ?, ?, ?, ?);
         INSERT INTO earnings (id, btc_address, amount_sats, reason, reference_id, created_at)
           VALUES (?, ?, 0, 'signal', ?, ?);
         COMMIT;`,
        signalId,
        beat_slug as string,
        btc_address as string,
        sanitizeString(headline, 120),
        sanitizedBody,
        sourcesJson,
        nowIso,
        nowIso,
        ...tagParams,
        btc_address as string,
        currentStreak,
        longestStreak,
        today,
        totalSignals,
        earningId,
        btc_address as string,
        signalId,
        nowIso
      );

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

      const row = created[0] as Record<string, unknown>;
      const signal: Signal = {
        ...(row as object),
        sources: JSON.parse(row.sources as string) as Signal["sources"],
        tags: row.tags_csv ? String(row.tags_csv).split(",") : [],
        tags_csv: undefined,
      } as unknown as Signal;

      return c.json({ ok: true, data: signal } satisfies DOResult<Signal>, 201);
    });

    // PATCH /signals/:id — correction: create new signal with correction_of pointing to original
    this.router.patch("/signals/:id", async (c) => {
      const originalId = c.req.param("id");

      let body: Record<string, unknown>;
      try {
        body = await c.req.json<Record<string, unknown>>();
      } catch {
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
      const sanitizedBody = signalBody ? sanitizeString(signalBody, 1000) : null;
      const correctionTags = (tags as string[]) ?? [];

      const tagInserts = correctionTags
        .map(() => `INSERT INTO signal_tags (signal_id, tag) VALUES (?, ?);`)
        .join("\n");
      const tagParams: unknown[] = [];
      for (const t of correctionTags) {
        tagParams.push(newId, t);
      }

      this.ctx.storage.sql.exec(
        `BEGIN;
         INSERT INTO signals (id, beat_slug, btc_address, headline, body, sources, created_at, updated_at, correction_of)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
         ${tagInserts}
         COMMIT;`,
        newId,
        original.beat_slug as string,
        btc_address as string,
        headline ? sanitizeString(headline, 120) : sanitizeString(original.headline, 120),
        sanitizedBody,
        sourcesJson,
        nowIso,
        nowIso,
        originalId,
        ...tagParams
      );

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

      const row = created[0] as Record<string, unknown>;
      const correctedSignal: Signal = {
        ...(row as object),
        sources: JSON.parse(row.sources as string) as Signal["sources"],
        tags: row.tags_csv ? String(row.tags_csv).split(",") : [],
        tags_csv: undefined,
      } as unknown as Signal;

      return c.json({ ok: true, data: correctedSignal } satisfies DOResult<Signal>);
    });

    // -------------------------------------------------------------------------
    // Briefs CRUD
    // -------------------------------------------------------------------------

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
      let body: Record<string, unknown> = {};
      try {
        body = await c.req.json<Record<string, unknown>>();
      } catch {
        // Body is optional — use defaults
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
           WHERE s.created_at >= ? AND s.created_at < ?
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
      let body: Record<string, unknown>;
      try {
        body = await c.req.json<Record<string, unknown>>();
      } catch {
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
        `INSERT OR REPLACE INTO briefs (date, text, json_data, compiled_at, inscribed_txid, inscription_id)
         VALUES (?, ?, ?, ?, NULL, NULL)`,
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

      let body: Record<string, unknown>;
      try {
        body = await c.req.json<Record<string, unknown>>();
      } catch {
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
      let body: Record<string, unknown>;
      try {
        body = await c.req.json<Record<string, unknown>>();
      } catch {
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
                  st.current_streak,
                  st.longest_streak,
                  st.total_signals,
                  st.last_signal_date
           FROM signals s
           LEFT JOIN streaks st ON s.btc_address = st.btc_address
           GROUP BY s.btc_address
           ORDER BY signal_count DESC`
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

    // GET /status/:address
    this.router.get("/status/:address", (c) => {
      const address = c.req.param("address");

      // Recent signals (last 10)
      const signalRows = this.ctx.storage.sql
        .exec(
          `SELECT * FROM signals WHERE btc_address = ? ORDER BY created_at DESC LIMIT 10`,
          address
        )
        .toArray();

      // Streak
      const streakRows = this.ctx.storage.sql
        .exec("SELECT * FROM streaks WHERE btc_address = ?", address)
        .toArray();

      // Earnings (last 10)
      const earningRows = this.ctx.storage.sql
        .exec(
          `SELECT * FROM earnings WHERE btc_address = ? ORDER BY created_at DESC LIMIT 10`,
          address
        )
        .toArray();

      return c.json({
        ok: true,
        data: {
          address,
          signals: signalRows,
          streak: streakRows[0] ?? null,
          earnings: earningRows,
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
           ORDER BY date DESC`
        )
        .toArray();
      return c.json({ ok: true, data: rows } satisfies DOResult<unknown[]>);
    });

    // -------------------------------------------------------------------------
    // Report — aggregate stats
    // -------------------------------------------------------------------------

    // GET /report
    this.router.get("/report", (c) => {
      const today = getPacificDate(new Date());
      const yesterday = getPacificYesterday(new Date());

      // Total signals today (Pacific date)
      const signalsTodayRows = this.ctx.storage.sql
        .exec(
          `SELECT COUNT(*) as count FROM signals WHERE DATE(created_at) >= ?`,
          today
        )
        .toArray();

      // Total beats
      const beatsRows = this.ctx.storage.sql
        .exec("SELECT COUNT(*) as count FROM beats")
        .toArray();

      // Total signals all time
      const totalSignalsRows = this.ctx.storage.sql
        .exec("SELECT COUNT(*) as count FROM signals")
        .toArray();

      // Active correspondents (filed today)
      const activeRows = this.ctx.storage.sql
        .exec(
          `SELECT COUNT(DISTINCT btc_address) as count FROM signals WHERE DATE(created_at) >= ?`,
          today
        )
        .toArray();

      // Latest brief
      const briefRows = this.ctx.storage.sql
        .exec("SELECT date, inscribed_txid, inscription_id FROM briefs ORDER BY date DESC LIMIT 1")
        .toArray();

      // Top agents by signal count
      const topAgentsRows = this.ctx.storage.sql
        .exec(
          `SELECT btc_address, COUNT(*) as signal_count FROM signals GROUP BY btc_address ORDER BY signal_count DESC LIMIT 5`
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

    // GET /earnings/:address
    this.router.get("/earnings/:address", (c) => {
      const address = c.req.param("address");
      const rows = this.ctx.storage.sql
        .exec(
          "SELECT * FROM earnings WHERE btc_address = ? ORDER BY created_at DESC",
          address
        )
        .toArray();
      return c.json({ ok: true, data: rows as unknown as Earning[] } satisfies DOResult<Earning[]>);
    });

    this.router.all("*", (c) => {
      return c.json({ ok: false, error: "Not found" }, 404);
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.router.fetch(request);
  }
}
