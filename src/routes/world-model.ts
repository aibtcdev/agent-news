import { Hono } from "hono";
import type { Env, AppVariables, Beat } from "../lib/types";
import { getSignalCounts, listBeats, listSignals } from "../lib/do-client";

const worldModelRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_REVIEWED_SIGNALS_LIMIT = 50;

function defaultSince(): string {
  return new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString();
}

function latestReviewedAt(signals: Array<{ reviewed_at?: string | null }>): string | null {
  const reviewed = signals
    .map((signal) => signal.reviewed_at)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => b.localeCompare(a));
  return reviewed[0] ?? null;
}

function transformBeat(beat: Beat) {
  const members = beat.members ?? [];
  return {
    slug: beat.slug,
    name: beat.name,
    status: beat.status,
    editor: beat.editor
      ? { address: beat.editor.btc_address, assignedAt: beat.editor.registered_at, lastReviewedAt: null as string | null }
      : null,
    members: { count: members.length },
    coverageGapIndex: 0,
  };
}

// GET /api/world-model/beat-health — DRI-queryable beat health snapshot.
worldModelRouter.get("/api/world-model/beat-health", async (c) => {
  const since = c.req.query("since") ?? defaultSince();
  if (Number.isNaN(Date.parse(since))) {
    return c.json({ ok: false, error: "Invalid since query parameter; expected an ISO-compatible date string." }, 400);
  }

  const beats = await listBeats(c.env);
  const rows = await Promise.all(
    beats.map(async (beat) => {
      const row = transformBeat(beat);
      const [counts, approvedSignals, rejectedSignals] = await Promise.all([
        getSignalCounts(c.env, { beat: beat.slug, since }),
        listSignals(c.env, { beat: beat.slug, status: "approved", since, limit: RECENT_REVIEWED_SIGNALS_LIMIT }),
        listSignals(c.env, { beat: beat.slug, status: "rejected", since, limit: RECENT_REVIEWED_SIGNALS_LIMIT }),
      ]);
      return {
        ...row,
        signals: counts,
        editor: row.editor
          ? { ...row.editor, lastReviewedAt: latestReviewedAt([...approvedSignals, ...rejectedSignals]) }
          : null,
        coverageGapIndex: counts.total > 0 ? Number((counts.submitted / counts.total).toFixed(4)) : 0,
      };
    })
  );

  const totals = rows.reduce(
    (acc, row) => {
      acc.beats += 1;
      if (row.status === "active") acc.activeBeats += 1;
      acc.signals += row.signals.total;
      acc.submitted += row.signals.submitted;
      acc.approved += row.signals.approved;
      acc.brief_included += row.signals.brief_included;
      acc.rejected += row.signals.rejected;
      acc.replaced += row.signals.replaced;
      return acc;
    },
    { beats: 0, activeBeats: 0, signals: 0, submitted: 0, approved: 0, brief_included: 0, rejected: 0, replaced: 0 }
  );

  c.header("Cache-Control", "public, max-age=30, s-maxage=60");
  return c.json({
    generatedAt: new Date().toISOString(),
    window: { since },
    totals,
    beats: rows,
  });
});

export { worldModelRouter };
