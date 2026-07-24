/**
 * SQL schema for LegionDO SQLite storage.
 *
 * Deliberately separate from NewsDO. The Legion write path is driven by
 * inbound chainhook webhooks on an unpredictable schedule, and its read path
 * backs a live-updating page; folding either into the news singleton would put
 * that traffic onto the DO that already dominates rows-read cost, and would
 * couple a testnet-only feature to a DO that needs a manual redeploy to cycle.
 *
 * All tables use CREATE TABLE IF NOT EXISTS for safe re-initialization.
 */
export const LEGION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS legion_events (
  txid          TEXT NOT NULL,
  event_index   INTEGER NOT NULL DEFAULT 0,
  -- Which deployment emitted this. Clarity contracts are immutable, so every
  -- governance change ships as a new contract id, and the old one keeps its
  -- history. Carrying the id per row lets a redeploy land without truncating
  -- the feed: past cycles stay readable, queries scope to the active contract,
  -- and a migration is a constant change rather than a data wipe. Adding this
  -- column later would mean backfilling rows whose origin is unrecoverable.
  contract_id   TEXT NOT NULL,
  block_height  INTEGER NOT NULL,
  block_time    INTEGER,
  event         TEXT NOT NULL,
  brief_date    TEXT,
  actor         TEXT,
  payload       TEXT NOT NULL,
  recorded_at   INTEGER NOT NULL,
  PRIMARY KEY (txid, event_index)
);

-- The page's primary read: newest-first activity for one week of one deployment.
CREATE INDEX IF NOT EXISTS idx_legion_events_brief
  ON legion_events(contract_id, brief_date, block_height DESC);

-- Global feed and the "what have we indexed through" watermark.
CREATE INDEX IF NOT EXISTS idx_legion_events_height
  ON legion_events(contract_id, block_height DESC);
`;
