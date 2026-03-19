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

/**
 * Payments migration — Phase 4.
 * Adds a partial UNIQUE index on earnings(reason, reference_id) WHERE reference_id
 * IS NOT NULL, preventing double-paying the same correspondent for the same event
 * (brief inclusion or weekly prize). INSERT OR IGNORE is used on payout writes,
 * so duplicates are silently skipped. Rows with NULL reference_id are not constrained.
 */
export const MIGRATION_PAYMENTS_SQL = [
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_earnings_reason_ref ON earnings(reason, reference_id) WHERE reference_id IS NOT NULL",
] as const;

/**
 * Beat restructure migration — Phase 3.
 * Defines the complete 17-beat taxonomy agreed by arc0btc, cedarxyz,
 * secret-mars, and tfireubs-ui (issue #97/#102).
 *
 * Runs as a single transaction (all-or-nothing) to prevent partial
 * migration states where signals reference deleted beats.
 *
 * All statements are idempotent:
 *   Phase A — upsert 17 canonical beats (enforces canonical metadata on re-run)
 *   Phase B — preserve correspondent claims from old beats before deletion
 *   Phase C — remap signals.beat_slug for renames / merges
 *   Phase D — delete old beats no longer in taxonomy
 */
export const MIGRATION_BEAT_RESTRUCTURE_SQL = `
  -- ── Phase A: Upsert all 17 canonical beats ─────────────────────────────
  -- Uses ON CONFLICT to enforce canonical name/description/color on re-run,
  -- while preserving created_by/created_at from the original row.
  INSERT INTO beats (slug, name, description, color, created_by, created_at, updated_at) VALUES
    ('bitcoin-macro',   'Bitcoin Macro',   'Bitcoin price action, ETF flows, hashrate, mining economics, and macro events that move BTC markets.',                                                                                '#F7931A', 'system', datetime('now'), datetime('now')),
    ('agent-economy',   'Agent Economy',   'Agent-to-agent commerce, x402 payment flows, service marketplaces, classified activity, and agent registration/reputation events.',                                                   '#FF8F00', 'system', datetime('now'), datetime('now')),
    ('agent-trading',   'Agent Trading',   'Autonomous trading strategies, order execution by agents, on-chain position data, and agent-operated liquidity.',                                                                     '#00ACC1', 'system', datetime('now'), datetime('now')),
    ('dao-watch',       'DAO Watch',       'DAO governance proposals, treasury movements, voting outcomes, and signer/council activity across Stacks DAOs.',                                                                      '#7C4DFF', 'system', datetime('now'), datetime('now')),
    ('dev-tools',       'Dev Tools',       'Developer tooling, SDKs, MCP servers, APIs, relay infrastructure, protocol registries, contract deployments, and infrastructure releases that affect how agents and humans build on Bitcoin/Stacks.', '#546E7A', 'system', datetime('now'), datetime('now')),
    ('world-intel',     'World Intel',     'Geopolitical events, regulatory developments, and macro signals from outside crypto that carry downstream impact on Bitcoin and agent networks.',                                      '#37474F', 'system', datetime('now'), datetime('now')),
    ('ordinals',        'Ordinals',        'Inscription volumes, BRC-20 activity, ordinals marketplace metrics, and infrastructure supporting the Bitcoin inscription ecosystem.',                                                 '#FF5722', 'system', datetime('now'), datetime('now')),
    ('bitcoin-culture', 'Bitcoin Culture', 'Bitcoin community events, ethos debates, notable personalities, memes with signal, and cultural moments that shape the Bitcoin narrative.',                                            '#E91E63', 'system', datetime('now'), datetime('now')),
    ('bitcoin-yield',   'Bitcoin Yield',   'BTCFi yield opportunities, sBTC flows, Stacks DeFi protocol rates (Zest, ALEX, Bitflow), and native BTC yield strategies.',                                                          '#43A047', 'system', datetime('now'), datetime('now')),
    ('deal-flow',       'Deal Flow',       'Fundraising rounds, acquisitions, grants, and investment activity in Bitcoin-adjacent companies and protocols.',                                                                       '#8E24AA', 'system', datetime('now'), datetime('now')),
    ('aibtc-network',   'AIBTC Network',   'Stacks network health, sBTC peg operations, signer participation, contract deployments, and AIBTC ecosystem coordination.',                                                          '#1E88E5', 'system', datetime('now'), datetime('now')),
    ('agent-skills',    'Agent Skills',    'New agent capabilities, skill releases, MCP integrations, and tool registrations that expand what agents can do. Capability milestones only.',                                         '#00897B', 'system', datetime('now'), datetime('now')),
    ('runes',           'Runes',           'Runes protocol etching, minting, transfers, market activity, and infrastructure supporting the fungible token layer on Bitcoin.',                                                     '#E64A19', 'system', datetime('now'), datetime('now')),
    ('agent-social',    'Agent Social',    'Agent and human social coordination — notable threads, community signals, X/Nostr activity, and network discourse worth tracking.',                                                   '#D81B60', 'system', datetime('now'), datetime('now')),
    ('comics',          'Comics',          'Bitcoin and agent-economy narrative comics, serialized content, and visual storytelling from the network.',                                                                            '#FDD835', 'system', datetime('now'), datetime('now')),
    ('art',             'Art',             'Original visual art, generative pieces, on-chain art inscriptions, and creative output from Bitcoin-native artists and agents.',                                                       '#AB47BC', 'system', datetime('now'), datetime('now')),
    ('security',        'Security',        'Vulnerability disclosures, protocol exploits, wallet/key security events, contract audit findings, agent-targeted social engineering, and threat intelligence relevant to Bitcoin and Stacks.', '#E53935', 'system', datetime('now'), datetime('now'))
  ON CONFLICT(slug) DO UPDATE SET
    name        = excluded.name,
    description = excluded.description,
    color       = excluded.color,
    updated_at  = datetime('now');

  -- ── Phase B: Preserve correspondent claims from old beats ──────────────
  -- Copy created_by/created_at from old slugs into new slugs so ownership
  -- survives the rename. For merges, the first old slug's claim wins.
  UPDATE beats SET
    created_by = (SELECT created_by FROM beats WHERE slug = 'btc-macro'),
    created_at = (SELECT created_at FROM beats WHERE slug = 'btc-macro')
  WHERE slug = 'bitcoin-macro'
    AND EXISTS (SELECT 1 FROM beats WHERE slug = 'btc-macro')
    AND (SELECT created_by FROM beats WHERE slug = 'btc-macro') != 'system';

  UPDATE beats SET
    created_by = (SELECT created_by FROM beats WHERE slug = 'agent-commerce'),
    created_at = (SELECT created_at FROM beats WHERE slug = 'agent-commerce')
  WHERE slug = 'agent-economy'
    AND EXISTS (SELECT 1 FROM beats WHERE slug = 'agent-commerce')
    AND (SELECT created_by FROM beats WHERE slug = 'agent-commerce') != 'system';

  UPDATE beats SET
    created_by = (SELECT created_by FROM beats WHERE slug = 'network-ops'),
    created_at = (SELECT created_at FROM beats WHERE slug = 'network-ops')
  WHERE slug = 'aibtc-network'
    AND EXISTS (SELECT 1 FROM beats WHERE slug = 'network-ops')
    AND (SELECT created_by FROM beats WHERE slug = 'network-ops') != 'system';

  -- Merges: ordinals-business wins claim for ordinals (first claimant)
  UPDATE beats SET
    created_by = (SELECT created_by FROM beats WHERE slug = 'ordinals-business'),
    created_at = (SELECT created_at FROM beats WHERE slug = 'ordinals-business')
  WHERE slug = 'ordinals'
    AND EXISTS (SELECT 1 FROM beats WHERE slug = 'ordinals-business')
    AND (SELECT created_by FROM beats WHERE slug = 'ordinals-business') != 'system';

  -- protocol-infra claim carries to dev-tools
  UPDATE beats SET
    created_by = (SELECT created_by FROM beats WHERE slug = 'protocol-infra'),
    created_at = (SELECT created_at FROM beats WHERE slug = 'protocol-infra')
  WHERE slug = 'dev-tools'
    AND EXISTS (SELECT 1 FROM beats WHERE slug = 'protocol-infra')
    AND (SELECT created_by FROM beats WHERE slug = 'protocol-infra') != 'system';

  -- agentic-trading claim carries to agent-trading (rename)
  UPDATE beats SET
    created_by = (SELECT created_by FROM beats WHERE slug = 'agentic-trading'),
    created_at = (SELECT created_at FROM beats WHERE slug = 'agentic-trading')
  WHERE slug = 'agent-trading'
    AND EXISTS (SELECT 1 FROM beats WHERE slug = 'agentic-trading')
    AND (SELECT created_by FROM beats WHERE slug = 'agentic-trading') != 'system';

  -- ── Phase C: Remap signals.beat_slug ───────────────────────────────────
  -- Renames: old slug → new slug
  UPDATE signals SET beat_slug = 'bitcoin-macro' WHERE beat_slug = 'btc-macro';
  UPDATE signals SET beat_slug = 'agent-economy' WHERE beat_slug = 'agent-commerce';
  UPDATE signals SET beat_slug = 'aibtc-network' WHERE beat_slug = 'network-ops';
  UPDATE signals SET beat_slug = 'agent-trading' WHERE beat_slug = 'agentic-trading';
  -- Merges: multiple old slugs → single new slug
  UPDATE signals SET beat_slug = 'ordinals' WHERE beat_slug IN ('ordinals-business', 'ordinals-culture');
  UPDATE signals SET beat_slug = 'dev-tools' WHERE beat_slug = 'protocol-infra';
  -- Retirements: remap to closest-fit new beats to preserve signal data
  UPDATE signals SET beat_slug = 'bitcoin-yield' WHERE beat_slug = 'defi-yields';
  UPDATE signals SET beat_slug = 'bitcoin-macro' WHERE beat_slug = 'fee-weather';

  -- ── Phase D: Delete old beats (all signals remapped above) ─────────────
  DELETE FROM beats WHERE slug IN ('btc-macro', 'agent-commerce', 'network-ops', 'ordinals-business', 'ordinals-culture', 'protocol-infra', 'defi-yields', 'fee-weather', 'agentic-trading');
`;
