/**
 * SQL schema for NewsDO SQLite storage.
 * All tables use CREATE TABLE IF NOT EXISTS for safe re-initialization.
 */
export const SCHEMA_SQL = `
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
  id           TEXT PRIMARY KEY,
  beat_slug    TEXT NOT NULL REFERENCES beats(slug),
  btc_address  TEXT NOT NULL,
  headline     TEXT NOT NULL,
  body         TEXT,
  sources      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  correction_of TEXT
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

CREATE TABLE IF NOT EXISTS bounties (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL,
  reward_sats         INTEGER NOT NULL,
  creator_btc_address TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',
  payment_txid        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bounty_submissions (
  id                     TEXT PRIMARY KEY,
  bounty_id              TEXT NOT NULL REFERENCES bounties(id),
  submitter_btc_address  TEXT NOT NULL,
  body                   TEXT NOT NULL,
  url                    TEXT,
  created_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signal_tags_tag               ON signal_tags(tag);
CREATE INDEX IF NOT EXISTS idx_signals_beat_slug             ON signals(beat_slug);
CREATE INDEX IF NOT EXISTS idx_signals_btc_address           ON signals(btc_address);
CREATE INDEX IF NOT EXISTS idx_signals_created_at            ON signals(created_at);
CREATE INDEX IF NOT EXISTS idx_signals_correction_of         ON signals(correction_of);
CREATE INDEX IF NOT EXISTS idx_earnings_btc_address          ON earnings(btc_address);
CREATE INDEX IF NOT EXISTS idx_classifieds_expires_at        ON classifieds(expires_at);
CREATE INDEX IF NOT EXISTS idx_classifieds_category          ON classifieds(category);
CREATE INDEX IF NOT EXISTS idx_bounties_status               ON bounties(status);
CREATE INDEX IF NOT EXISTS idx_bounties_creator              ON bounties(creator_btc_address);
CREATE INDEX IF NOT EXISTS idx_bounty_submissions_bounty_id  ON bounty_submissions(bounty_id);
`;
