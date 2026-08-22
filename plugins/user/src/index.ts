import { definePlugin, type LedgerPlugin, type SqliteDb, type UserRecord, type UserService } from '@ledger/plugin-contract'

/**
 * plugin-user — 身份目录（L1 + 服务提供者）。
 * users 表由本插件自带（内核无感知），经入口装配提供的 'db' 服务读写；
 * 对外暴露 'user' 服务 + user.* 命令（kernel 薄转发）。
 * 本插件不在场时消费方降级：recorder 回退 'me'（值冗余，历史不失效）。
 */

interface UserRow {
  id: string
  name: string
  kind: string
  is_default: number
  created_at: number
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'bot' ? 'bot' : 'human',
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
  }
}

export const userPlugin: LedgerPlugin = definePlugin({
  manifest: {
    name: 'plugin-user',
    version: '0.1.0',
    isolation: 'inprocess',
    provides: ['user'],
  },
  async activate(host) {
    const db = host.services.get<SqliteDb>('db')
    if (!db) {
      throw new Error(`plugin-user requires the 'db' service (provided by entry assembly); not available in this process`)
    }
    // 自带表：不存在则建（与 V1 DDL 同构；插件独立于内核迁移框架）
    db.exec(`CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      kind       TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`)
    // 首次启动种子默认用户 me（幂等）
    db.prepare('INSERT OR IGNORE INTO users (id, name, kind, is_default, created_at) VALUES (?, ?, ?, 1, ?)').run(
      'me', 'me', 'human', Date.now(),
    )

    const service: UserService = {
      getUserId: () => {
        const row = db
          .prepare('SELECT * FROM users WHERE is_default = 1 ORDER BY created_at LIMIT 1')
          .get() as UserRow | undefined
        return row?.id ?? 'me'
      },
      getUser: (id) => {
        const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
        return row ? toRecord(row) : undefined
      },
      listUsers: () =>
        (db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[]).map(toRecord),
      setUserName: (id, name) => {
        const res = db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id) as { changes: number }
        if (res.changes === 0) {
          throw new Error(`user not found: ${id}`)
        }
        return toRecord(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow)
      },
    }
    host.services.provide('user', service)
  },
  async deactivate() {
    // 'user' 服务随内核 cleanupOwner 自动注销
  },
})
