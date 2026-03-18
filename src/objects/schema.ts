/**
 * SQL schema for NewsDO SQLite storage.
 * All tables use CREATE TABLE IF NOT EXISTS for safe re-initialization.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS beats (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  color       TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id                TEXT PRIMARY KEY,
  beat_slug         TEXT NOT NULL REFERENCES beats(slug),
  btc_address       TEXT NOT NULL,
  headline          TEXT NOT NULL,
  body              TEXT,
  sources           TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  correction_of     TEXT,
  status            TEXT NOT NULL DEFAULT 'submitted',
  publisher_feedback TEXT,
  reviewed_at       TEXT,
  disclosure        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS signal_tags (
  signal_id TEXT NOT NULL REFERENCES signals(id),
  tag       TEXT NOT NULL,
  PRIMARY KEY (signal_id, tag)
);

CREATE TABLE IF NOT EXISTS briefs (
  date          TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  json_data     TEXT,
  compiled_at   TEXT NOT NULL,
  inscribed_txid TEXT,
  inscription_id TEXT
);

CREATE TABLE IF NOT EXISTS streaks (
  btc_address      TEXT PRIMARY KEY,
  current_streak   INTEGER NOT NULL DEFAULT 0,
  longest_streak   INTEGER NOT NULL DEFAULT 0,
  last_signal_date TEXT,
  total_signals    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS earnings (
  id          TEXT PRIMARY KEY,
  btc_address TEXT NOT NULL,
  amount_sats INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  reference_id TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classifieds (
  id           TEXT PRIMARY KEY,
  btc_address  TEXT NOT NULL,
  category     TEXT NOT NULL,
  headline     TEXT NOT NULL,
  body         TEXT,
  contact      TEXT,
  payment_txid TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brief_signals (
  brief_date  TEXT NOT NULL,
  signal_id   TEXT NOT NULL,
  btc_address TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (brief_date, signal_id)
);

CREATE TABLE IF NOT EXISTS corrections (
  id           TEXT PRIMARY KEY,
  signal_id    TEXT NOT NULL,
  btc_address  TEXT NOT NULL,
  claim        TEXT NOT NULL,
  correction   TEXT NOT NULL,
  sources      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  reviewed_by  TEXT,
  reviewed_at  TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS referral_credits (
  id               TEXT PRIMARY KEY,
  scout_address    TEXT NOT NULL,
  recruit_address  TEXT NOT NULL,
  first_signal_id  TEXT,
  credited_at      TEXT,
  created_at       TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_signal_tags_tag          ON signal_tags(tag);
CREATE INDEX IF NOT EXISTS idx_signals_beat_slug        ON signals(beat_slug);
CREATE INDEX IF NOT EXISTS idx_signals_btc_address      ON signals(btc_address);
CREATE INDEX IF NOT EXISTS idx_signals_created_at       ON signals(created_at);
CREATE INDEX IF NOT EXISTS idx_signals_correction_of    ON signals(correction_of);
CREATE INDEX IF NOT EXISTS idx_earnings_btc_address     ON earnings(btc_address);
CREATE INDEX IF NOT EXISTS idx_classifieds_btc_address  ON classifieds(btc_address);
CREATE INDEX IF NOT EXISTS idx_classifieds_expires_at   ON classifieds(expires_at);
CREATE INDEX IF NOT EXISTS idx_classifieds_category     ON classifieds(category);
CREATE INDEX IF NOT EXISTS idx_brief_signals_address    ON brief_signals(btc_address);
CREATE INDEX IF NOT EXISTS idx_brief_signals_date       ON brief_signals(brief_date);
CREATE INDEX IF NOT EXISTS idx_corrections_signal       ON corrections(signal_id);
CREATE INDEX IF NOT EXISTS idx_corrections_address      ON corrections(btc_address);
CREATE INDEX IF NOT EXISTS idx_referral_scout           ON referral_credits(scout_address);
CREATE INDEX IF NOT EXISTS idx_referral_recruit         ON referral_credits(recruit_address);
`;

/**
 * Migration SQL for existing databases that lack Phase 0 columns.
 * Each statement is wrapped in a try/catch-friendly pattern (columns may already exist).
 * Run via news-do constructor after SCHEMA_SQL.
 */
export const MIGRATION_PHASE0_SQL = [
  "ALTER TABLE signals ADD COLUMN status TEXT NOT NULL DEFAULT 'submitted'",
  "ALTER TABLE signals ADD COLUMN publisher_feedback TEXT",
  "ALTER TABLE signals ADD COLUMN reviewed_at TEXT",
  "ALTER TABLE signals ADD COLUMN disclosure TEXT NOT NULL DEFAULT ''",
  "CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status)",
] as const;
