import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  definePlugin,
  type LedgerPlugin,
  type SnapshotInfo,
  type SnapshotService,
  type SqliteDb,
} from '@ledger/plugin-contract'

/**
 * plugin-snapshot — 快照与回迁（L1 + 服务提供者），单文件即备份单元。
 * - 全库：委托 Storage Core 原生快照 → <home>/snapshots/snapshot-<id>.db
 * - 账本级：<bookId> 的 entries + revisions + 引用的 type/field 定义 → JSON
 * - 回迁：全库 = Storage Core 校验、安全备份与事务整表替换；
 *         账本级 = 按原 id upsert（revision 续写）
 * 表结构经 'db' 服务（入口装配提供）读写，内核无感知；restore 后由 kernel 侧重载注册表。
 */

interface Row {
  [col: string]: unknown
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const FULL_RE = /^snapshot-\d+-[0-9a-f-]+\.db$/
const BOOK_RE = /^book-(.+)-(\d{8}-\d{6})\.json$/

/** 动态列名防注入：JSON 回迁文件的列必须是小写蛇形标识符 */
function assertSafeColumns(row: Row, table: string): string[] {
  const cols = Object.keys(row)
  for (const c of cols) {
    if (!/^[a-z][a-z0-9_]*$/.test(c)) {
      throw Object.assign(new Error(`illegal column "${c}" in snapshot table ${table}`), { code: 'SNAPSHOT_INVALID' })
    }
  }
  return cols
}

function upsertRows(db: SqliteDb, table: string, rows: Row[], mode: 'replace' | 'ignore'): void {
  if (rows.length === 0) return
  const cols = assertSafeColumns(rows[0]!, table)
  const sql = `INSERT OR ${mode === 'replace' ? 'REPLACE' : 'IGNORE'} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  const stmt = db.prepare(sql)
  for (const r of rows) stmt.run(...cols.map((c) => r[c]))
}

export const snapshotPlugin: LedgerPlugin = definePlugin({
  manifest: {
    name: 'plugin-snapshot',
    version: '0.1.0',
    isolation: 'inprocess',
    provides: ['snapshot'],
  },
  async activate(host) {
    const db = host.services.get<SqliteDb>('db')
    if (!db) {
      throw new Error(`plugin-snapshot requires the 'db' service (provided by entry assembly); not available in this process`)
    }
    const dir = join(host.meta.dataDir, 'snapshots')
    mkdirSync(dir, { recursive: true })

    const infoOf = (file: string, bookId?: string): SnapshotInfo => {
      const path = join(dir, file)
      const st = statSync(path)
      return {
        file,
        path,
        kind: FULL_RE.test(file) ? 'full' : 'book',
        ...(bookId !== undefined || BOOK_RE.test(file) ? { bookId: bookId ?? BOOK_RE.exec(file)?.[1] } : {}),
        createdAt: st.mtimeMs,
        sizeBytes: st.size,
      }
    }

    const restoreFull = async (file: string): Promise<number> => {
      await host.storage.switchSnapshot(file)
      return (db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c
    }

    const restoreBook = (file: string): number => {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
        format?: string
        bookId?: string
        entries?: Row[]
        revisions?: Row[]
        typeDefs?: Row[]
        fieldDefs?: Row[]
      }
      if (parsed.format !== 'ledger.book/v1') {
        throw Object.assign(new Error(`unsupported snapshot format: ${String(parsed.format)}`), { code: 'SNAPSHOT_INVALID' })
      }
      upsertRows(db, 'type_defs', parsed.typeDefs ?? [], 'replace')
      upsertRows(db, 'field_defs', parsed.fieldDefs ?? [], 'replace')
      // 修订先入（保留原 id，冲突忽略）；条目按原 id upsert，revision 从快照续写
      upsertRows(db, 'entry_revisions', parsed.revisions ?? [], 'ignore')
      upsertRows(db, 'entries', parsed.entries ?? [], 'replace')
      return (parsed.entries ?? []).length
    }

    const service: SnapshotService = {
      create: async (scope, bookId = 'default') => {
        let file: string
        if (scope === 'full') {
          const snapshot = await host.storage.createSnapshot()
          file = snapshot.id
          return infoOf(file)
        }
        file = `book-${bookId}-${stamp()}.json`
        const entries = db.prepare('SELECT * FROM entries WHERE book_id = ?').all(bookId) as Row[]
        const ids = entries.map((e) => e['id'])
        const revisions = ids.length
          ? (db
              .prepare(`SELECT * FROM entry_revisions WHERE entry_id IN (${ids.map(() => '?').join(', ')})`)
              .all(...ids) as Row[])
          : []
        const typeKeys = [...new Set(entries.map((e) => e['type']).filter((t): t is string => typeof t === 'string'))]
        const typeDefs = typeKeys.length
          ? (db.prepare(`SELECT * FROM type_defs WHERE key IN (${typeKeys.map(() => '?').join(', ')})`).all(...typeKeys) as Row[])
          : []
        const fieldKeys = new Set<string>()
        for (const e of entries) {
          try {
            const extra = JSON.parse(String(e['extra'] ?? '{}')) as Record<string, unknown>
            for (const k of Object.keys(extra)) fieldKeys.add(k)
          } catch {
            // extra 损坏的行跳过字段收集
          }
        }
        const fieldDefs = fieldKeys.size
          ? (db
              .prepare(`SELECT * FROM field_defs WHERE key IN (${[...fieldKeys].map(() => '?').join(', ')})`)
              .all(...[...fieldKeys]) as Row[])
          : []
        const doc = {
          format: 'ledger.book/v1',
          bookId,
          exportedAt: Date.now(),
          schemaNote: 'rows are SELECT * output of the source database',
          entries,
          revisions,
          typeDefs,
          fieldDefs,
        }
        writeFileSync(join(dir, file), JSON.stringify(doc, null, 2), 'utf8')
        return infoOf(file, bookId)
      },

      list: () =>
        readdirSync(dir)
          .filter((f) => FULL_RE.test(f) || BOOK_RE.test(f))
          .sort()
          .reverse()
          .map((f) => infoOf(f)),

      restore: async (file) => {
        // basename 收敛：file 参数不允许携带路径（快照均位于 snapshots 目录内）
        const name = basename(file)
        if (!existsSync(join(dir, name)) || (!FULL_RE.test(name) && !BOOK_RE.test(name))) {
          throw Object.assign(new Error(`snapshot not found: ${name}`), { code: 'SNAPSHOT_NOT_FOUND' })
        }
        const entriesAffected = FULL_RE.test(name) ? await restoreFull(name) : restoreBook(name)
        return { restored: infoOf(name), entriesAffected }
      },
    }
    host.services.provide('snapshot', service)
  },
  async deactivate() {
    // 'snapshot' 服务随内核 cleanupOwner 自动注销
  },
})
