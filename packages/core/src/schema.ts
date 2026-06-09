// SQLite schema (FEAT-01-01, ADR-02, ADR-04). WAL and busy_timeout are set by
// the better-sqlite3 adapter only (ADR-02), not here. The reserved '__START__'
// capability row is inserted by the storage adapter on init.

export const USER_VERSION = 5

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  description TEXT,
  description_embedding BLOB,
  description_augmented TEXT,
  augmented_at TEXT,
  augmented_by TEXT,
  source TEXT,
  embedding_model TEXT,
  first_seen TEXT,
  last_seen TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  from_capability TEXT NOT NULL,
  to_capability   TEXT NOT NULL,
  pheromone       REAL NOT NULL DEFAULT 0.05,
  success_count   REAL NOT NULL DEFAULT 0,
  failure_count   REAL NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0,
  pin_behavior    TEXT,
  pin_owner       TEXT,
  last_updated    TEXT NOT NULL,
  PRIMARY KEY (from_capability, to_capability),
  FOREIGN KEY (from_capability) REFERENCES capabilities(id),
  FOREIGN KEY (to_capability) REFERENCES capabilities(id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  context_text TEXT,
  context_embedding BLOB,
  path TEXT,
  outcome TEXT,
  token_cost INTEGER,
  created_at TEXT,
  completed_at TEXT,
  source_host TEXT
);

CREATE TABLE IF NOT EXISTS pinned_paths (
  id TEXT PRIMARY KEY,
  name TEXT,
  description TEXT,
  capability_sequence TEXT,
  parameters_template TEXT,
  behavior TEXT,
  when_to_use TEXT,
  when_to_use_embedding BLOB,
  name_embedding BLOB,
  named_at TEXT,
  named_by TEXT,
  path_source TEXT,
  created_at TEXT,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS runtime_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edges_from_pheromone ON edges(from_capability, pheromone DESC);
CREATE INDEX IF NOT EXISTS idx_edges_pinned ON edges(pinned, pin_behavior);
CREATE INDEX IF NOT EXISTS idx_tasks_outcome ON tasks(outcome, completed_at);
CREATE INDEX IF NOT EXISTS idx_capabilities_type ON capabilities(type);
`

// Forward migrations keyed by the user_version they upgrade TO (FEAT-01-07). A fresh database
// is created at USER_VERSION directly from SCHEMA_SQL; an existing database runs every migration
// whose `to` is greater than its current user_version, in order. ALTER ADD COLUMN is safe because
// the new columns never exist on the prior version. The adapter sets user_version afterwards.
export const MIGRATIONS: ReadonlyArray<{ to: number; sql: string }> = [
  {
    to: 2,
    sql: `
ALTER TABLE capabilities ADD COLUMN description_augmented TEXT;
ALTER TABLE capabilities ADD COLUMN augmented_at TEXT;
ALTER TABLE capabilities ADD COLUMN augmented_by TEXT;
`,
  },
  {
    // EPIC-04 (ADR-17/18/19): one unified v3 migration for the inventory `source` marker, the
    // per-path whenToUse gate, and the emergent-naming columns. All additive and nullable, so a
    // v2 substrate migrates forward with no data change and every default is coerced on read.
    to: 3,
    sql: `
ALTER TABLE capabilities ADD COLUMN source TEXT;
ALTER TABLE pinned_paths ADD COLUMN when_to_use TEXT;
ALTER TABLE pinned_paths ADD COLUMN when_to_use_embedding BLOB;
ALTER TABLE pinned_paths ADD COLUMN name_embedding BLOB;
ALTER TABLE pinned_paths ADD COLUMN named_at TEXT;
ALTER TABLE pinned_paths ADD COLUMN named_by TEXT;
ALTER TABLE pinned_paths ADD COLUMN path_source TEXT;
`,
  },
  {
    // EPIC-04 (ADR-20, FEAT-04-06): a generic runtime key-value store shared across processes. The
    // enable flag is row key='enabled'; an absent row means disabled (default-disabled with no seed).
    to: 4,
    sql: `
CREATE TABLE IF NOT EXISTS runtime_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    // EPIC-04 (ADR-18, FEAT-04-07): the model hash that produced each description_embedding, so
    // consult reuses a stored vector only on a matching model and re-embeds on a mismatch (no silent
    // cross-space cosine). Additive/nullable: a pre-v5 vector reads NULL -> treated as unknown space.
    to: 5,
    sql: `
ALTER TABLE capabilities ADD COLUMN embedding_model TEXT;
`,
  },
]

/**
 * Bring a database from its current user_version up to USER_VERSION (FEAT-01-07). Shared by both
 * storage adapters so the migration policy lives in one place. The adapter passes `exec` (runs a
 * multi-statement SQL string) and `setVersion` (stamps user_version); it MUST wrap this whole call
 * in a single transaction so a crash mid-migration rolls back and the next open re-runs cleanly.
 *
 * - current 0: a fresh database already created at USER_VERSION by SCHEMA_SQL; only stamp the version.
 * - current in [1, USER_VERSION): run each migration whose `to` is greater than current, then stamp.
 * - current >= USER_VERSION: no-op. A newer database is NEVER downgraded (no version re-stamp).
 */
export function applyMigrations(current: number, exec: (sql: string) => void, setVersion: (v: number) => void): void {
  if (current >= USER_VERSION) return
  if (current > 0) {
    for (const m of MIGRATIONS) if (m.to > current) exec(m.sql)
  }
  setVersion(USER_VERSION)
}
