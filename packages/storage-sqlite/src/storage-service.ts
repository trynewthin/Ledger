import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type {
  StorageArtifact,
  StorageEntry,
  StorageImportPlan,
  StorageImportResult,
  StorageValue,
} from '@ledger/plugin-contract'

const STORAGE_FORMAT_VERSION = 1

/**
 * SQLite 存储核心：管理共享连接与无业务轻量数据，并提供整体数据导入导出。
 * Entry 等领域映射继续由 Repository 承担，避免存储核心理解业务语义。
 */
export class SqliteStorageService {
  constructor(
    private db: Database.Database,
    readonly databasePath: string,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS storage_kv (
        owner      TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner, key)
      );
      CREATE TABLE IF NOT EXISTS storage_component_migrations (
        owner      TEXT NOT NULL,
        version    INTEGER NOT NULL,
        applied_at INTEGER NOT NULL,
        PRIMARY KEY (owner, version)
      );
    `)
  }

  raw(): Database.Database {
    return this.db
  }

  transaction<T>(work: (db: Database.Database) => T): T {
    return this.db.transaction(() => work(this.db))()
  }

  migrate(owner: string, migrations: Array<{ version: number; up(db: Database.Database): void }>): number[] {
    const rows = this.db
      .prepare('SELECT version FROM storage_component_migrations WHERE owner = ?')
      .all(owner) as Array<{ version: number }>
    const applied = new Set(rows.map((row) => row.version))
    const completed: number[] = []
    for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(migration.version)) continue
      this.transaction((db) => {
        migration.up(db)
        db.prepare('INSERT INTO storage_component_migrations (owner, version, applied_at) VALUES (?, ?, ?)')
          .run(owner, migration.version, Date.now())
      })
      completed.push(migration.version)
    }
    return completed
  }

  get<T extends StorageValue = StorageValue>(owner: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM storage_kv WHERE owner = ? AND key = ?').get(owner, key) as
      | { value: string }
      | undefined
    return row ? JSON.parse(row.value) as T : undefined
  }

  set<T extends StorageValue = StorageValue>(owner: string, key: string, value: T): void {
    assertStorageKey(owner, key)
    this.db.prepare(`
      INSERT INTO storage_kv (owner, key, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(owner, key, JSON.stringify(value), Date.now())
  }

  delete(owner: string, key: string): void {
    this.db.prepare('DELETE FROM storage_kv WHERE owner = ? AND key = ?').run(owner, key)
  }

  list<T extends StorageValue = StorageValue>(owner: string, prefix = ''): StorageEntry<T>[] {
    const rows = this.db
      .prepare("SELECT key, value FROM storage_kv WHERE owner = ? AND key LIKE ? ESCAPE '\\' ORDER BY key")
      .all(owner, `${escapeLike(prefix)}%`) as Array<{ key: string; value: string }>
    return rows.map((row) => ({ key: row.key, value: JSON.parse(row.value) as T }))
  }

  async exportAll(options: { destination: string }): Promise<StorageArtifact> {
    const destination = options.destination
    await mkdir(dirname(destination), { recursive: true })
    // better-sqlite3 backup 在 WAL 写入并发存在时仍提供一致时间点快照。
    await this.db.backup(destination)
    const file = await stat(destination)
    return {
      path: destination,
      format: 'sqlite-native',
      formatVersion: STORAGE_FORMAT_VERSION,
      createdAt: Date.now(),
      sizeBytes: file.size,
      checksum: `sha256:${await sha256(destination)}`,
    }
  }

  async inspectImport(source: string): Promise<StorageImportPlan> {
    let sourceDb: Database.Database | undefined
    try {
      sourceDb = new Database(source, { readonly: true, fileMustExist: true })
      const sourceTables = userTables(sourceDb)
      const targetTables = userTables(this.db)
      const warnings: string[] = []
      for (const table of sourceTables) {
        if (!targetTables.includes(table)) {
          warnings.push(`target is missing table: ${table}`)
          continue
        }
        if (columnsOf(sourceDb, table).join('\0') !== columnsOf(this.db, table).join('\0')) {
          warnings.push(`table schema differs: ${table}`)
        }
      }
      for (const table of targetTables) {
        if (!sourceTables.includes(table)) warnings.push(`source is missing table: ${table}`)
      }
      return {
        source,
        format: 'sqlite-native',
        formatVersion: STORAGE_FORMAT_VERSION,
        compatible: warnings.length === 0,
        tables: sourceTables,
        warnings,
      }
    } catch (error) {
      return {
        source,
        format: 'sqlite-native',
        formatVersion: STORAGE_FORMAT_VERSION,
        compatible: false,
        tables: [],
        warnings: [error instanceof Error ? error.message : String(error)],
      }
    } finally {
      sourceDb?.close()
    }
  }

  async importAll(source: string, options: { createSafetyBackup?: boolean } = {}): Promise<StorageImportResult> {
    const plan = await this.inspectImport(source)
    if (!plan.compatible) {
      throw new Error(`storage import is incompatible: ${plan.warnings.join('; ')}`)
    }

    let safetyBackup: string | undefined
    if (options.createSafetyBackup !== false) {
      safetyBackup = `${this.databasePath}.before-import-${Date.now()}.db`
      await this.exportAll({ destination: safetyBackup })
    }

    this.db.prepare('ATTACH DATABASE ? AS ledger_import').run(source)
    try {
      // 数据回迁在同一事务内逐表替换；任意表失败都会恢复导入前的完整状态。
      this.transaction((db) => {
        db.pragma('defer_foreign_keys = ON')
        for (const table of plan.tables) {
          const quoted = quoteIdentifier(table)
          const columns = columnsOf(db, table).map(quoteIdentifier).join(', ')
          db.exec(`DELETE FROM ${quoted}`)
          db.exec(`INSERT INTO ${quoted} (${columns}) SELECT ${columns} FROM ledger_import.${quoted}`)
        }
      })
    } finally {
      this.db.exec('DETACH DATABASE ledger_import')
    }

    return {
      importedAt: Date.now(),
      tables: plan.tables,
      ...(safetyBackup ? { safetyBackup } : {}),
    }
  }

  close(): void {
    this.db.close()
  }
}

function userTables(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map((row) => row.name)
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>).map((row) => row.name)
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`unsafe SQLite identifier: ${value}`)
  return `"${value}"`
}

function assertStorageKey(owner: string, key: string): void {
  if (!owner) throw new Error('storage owner must be non-empty')
  if (!key) throw new Error('storage key must be non-empty')
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}
