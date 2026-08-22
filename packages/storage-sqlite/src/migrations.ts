import Database from 'better-sqlite3'

export interface Migration {
  version: number
  name: string
  up(db: Database.Database): void
}

/**
 * V1 起步：全部基础表。schema_version 逐行锁定于 entries，
 * schema_migrations 由迁移框架自管理。users 表由 plugin-user 使用（内核无感知）。
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE entries (
          id             TEXT PRIMARY KEY,
          book_id        TEXT NOT NULL DEFAULT 'default',
          direction      TEXT NOT NULL,
          amount_minor   INTEGER NOT NULL,
          currency       TEXT NOT NULL,
          occurred_at    INTEGER NOT NULL,
          recorded_at    INTEGER NOT NULL,
          source         TEXT NOT NULL,
          recorder       TEXT NOT NULL,
          type           TEXT,
          extra          TEXT NOT NULL DEFAULT '{}',
          schema_version INTEGER NOT NULL,
          revision       INTEGER NOT NULL DEFAULT 1,
          voided_at      INTEGER,
          void_reason    TEXT
        );
        CREATE INDEX idx_entries_book_time ON entries(book_id, occurred_at, direction);
        CREATE INDEX idx_entries_type      ON entries(type);

        CREATE TABLE entry_revisions (
          id         TEXT PRIMARY KEY,
          entry_id   TEXT NOT NULL,
          snapshot   TEXT NOT NULL,
          actor      TEXT NOT NULL,
          source     TEXT NOT NULL,
          revised_at INTEGER NOT NULL,
          reason     TEXT
        );
        CREATE INDEX idx_revisions_entry ON entry_revisions(entry_id, revised_at);

        CREATE TABLE type_defs (
          key           TEXT PRIMARY KEY,
          label         TEXT NOT NULL,
          direction     TEXT NOT NULL,
          parent_key    TEXT,
          icon          TEXT,
          origin        TEXT NOT NULL,
          owner         TEXT NOT NULL,
          schema        TEXT,
          enabled       INTEGER NOT NULL DEFAULT 1,
          registered_at INTEGER NOT NULL
        );

        CREATE TABLE field_defs (
          key           TEXT PRIMARY KEY,
          label         TEXT NOT NULL,
          scope         TEXT NOT NULL,
          value_type    TEXT NOT NULL,
          enum_values   TEXT,
          origin        TEXT NOT NULL,
          owner         TEXT NOT NULL,
          enabled       INTEGER NOT NULL DEFAULT 1,
          registered_at INTEGER NOT NULL
        );

        CREATE TABLE users (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          kind       TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
      `)
    },
  },
]

/** 迁移框架：记录于 schema_migrations，逐版本事务应用 */
export function migrate(db: Database.Database, migrations: Migration[] = MIGRATIONS): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`)
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]
  const applied = new Set(appliedRows.map((r) => r.version))
  const newlyApplied: number[] = []
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue
    const run = db.transaction(() => {
      m.up(db)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, Date.now())
    })
    run()
    newlyApplied.push(m.version)
  }
  return newlyApplied
}

export function appliedVersions(db: Database.Database): number[] {
  const rows = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as { version: number }[]
  return rows.map((r) => r.version)
}
