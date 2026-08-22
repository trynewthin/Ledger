import { afterAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { createEntry } from '@ledger/domain'
import { openDatabase } from './db.js'
import { appliedVersions, migrate } from './migrations.js'
import { SqliteEntryRepository } from './entry-repository.js'
import { SqliteMetadataStore } from './metadata-store.js'

const tmp = mkdtempSync(join(tmpdir(), 'ledger-sqlite-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function freshDb(name: string) {
  return openDatabase(join(tmp, `${name}.db`))
}

describe('migrations', () => {
  it('applies V1 on fresh db and is idempotent', () => {
    const db = freshDb('migrate')
    const applied = migrate(db)
    expect(applied).toEqual([1])
    expect(appliedVersions(db)).toEqual([1])
    migrate(db)
    expect(appliedVersions(db)).toEqual([1])
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name)
    for (const t of ['entries', 'entry_revisions', 'type_defs', 'field_defs', 'users', 'schema_migrations']) {
      expect(tables).toContain(t)
    }
  })

  it('runs in WAL mode', () => {
    const db = freshDb('wal')
    migrate(db)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
  })
})

describe('sqlite entry repository', () => {
  it('roundtrips entries, filters, and revisions', () => {
    const db = freshDb('repo')
    migrate(db)
    const repo = new SqliteEntryRepository(db)
    const now = Date.now()
    const a = createEntry({
      direction: 'expense', amountMinor: 1250, currency: 'CNY',
      occurredAt: now, recordedAt: now, source: 'cli', recorder: 'me',
      type: null, extra: { note: '午饭', payment_platform: 'alipay' }, schemaVersion: 1,
    })
    const b = createEntry({
      direction: 'income', amountMinor: 500, currency: 'USD',
      occurredAt: now + 1, recordedAt: now, source: 'mcp', recorder: 'bot:claude',
      schemaVersion: 1,
    })
    repo.insert(a)
    repo.insert(b)

    expect(repo.get(a.id)!.extra).toEqual({ note: '午饭', payment_platform: 'alipay' })
    const all = repo.list()
    expect(all.total).toBe(2)
    expect(all.items[0].id).toBe(b.id) // occurred_at DESC

    expect(repo.list({ direction: 'expense' }).total).toBe(1)
    expect(repo.list({ recorder: 'bot:claude' }).total).toBe(1)
    expect(repo.list({ type: null }).total).toBe(2)
    expect(repo.list({ from: now, to: now }).total).toBe(1)
    expect(repo.list({ limit: 1, offset: 1 }).items).toHaveLength(1)

    // 修订：原行可改 + 快照留痕
    const revised = { ...a, amountMinor: 1300, revision: 2 }
    repo.insertRevision({
      id: 'rev1', entryId: a.id, snapshot: JSON.stringify(a),
      actor: 'me', source: 'cli', revisedAt: now, reason: '改金额',
    })
    repo.replace(revised)
    expect(repo.get(a.id)!.amountMinor).toBe(1300)
    expect(repo.get(a.id)!.revision).toBe(2)
    const revs = repo.listRevisions(a.id)
    expect(revs).toHaveLength(1)
    expect(JSON.parse(revs[0]!.snapshot).amountMinor).toBe(1250)

    // 软删：默认不可见，includeVoided 可查
    repo.replace({ ...revised, voidedAt: now, voidReason: '记错' })
    expect(repo.list().total).toBe(1)
    expect(repo.list({ includeVoided: true }).total).toBe(2)
  })
})

describe('sqlite metadata store', () => {
  it('roundtrips type/field defs including enum values', () => {
    const db = freshDb('meta')
    migrate(db)
    const store = new SqliteMetadataStore(db)
    store.putType({
      key: 'food', label: '餐饮', direction: 'expense', parentKey: null, icon: 'utensils',
      schema: null, origin: 'plugin', owner: 'plugin-core-types', enabled: true, registeredAt: Date.now(),
    })
    store.putField({
      key: 'payment_platform', label: '付款平台', scope: 'both', valueType: 'enum',
      enumValues: [{ value: 'alipay', label: '支付宝', icon: 'wallet' }],
      origin: 'user', owner: 'user', enabled: true, registeredAt: Date.now(),
    })
    expect(store.getType('food')!.icon).toBe('utensils')
    expect(store.getField('payment_platform')!.enumValues![0]!.icon).toBe('wallet')
    expect(store.listTypes()).toHaveLength(1)
    store.deleteType('food')
    expect(store.getType('food')).toBeUndefined()
  })

  it('registry defs persist across reopen (数据自包含)', () => {
    const path = join(tmp, 'persist.db')
    const db1 = openDatabase(path)
    migrate(db1)
    const s1 = new SqliteMetadataStore(db1)
    s1.putType({
      key: 'salary', label: '工资', direction: 'income', parentKey: null, icon: null,
      schema: null, origin: 'user', owner: 'user', enabled: true, registeredAt: 1,
    })
    db1.close()
    const db2 = openDatabase(path)
    expect(new SqliteMetadataStore(db2).getType('salary')!.label).toBe('工资')
  })
})
