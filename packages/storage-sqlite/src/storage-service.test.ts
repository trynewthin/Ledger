import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase } from './db.js'
import { migrate } from './migrations.js'
import { SqliteStorageService } from './storage-service.js'

const dirs: string[] = []

async function fixture(name: string): Promise<{ dir: string; service: SqliteStorageService }> {
  const dir = await mkdtemp(join(tmpdir(), `ledger-storage-${name}-`))
  dirs.push(dir)
  const dbPath = join(dir, 'ledger.db')
  const db = openDatabase(dbPath)
  migrate(db)
  return { dir, service: new SqliteStorageService(db, dbPath) }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('SqliteStorageService', () => {
  it('provides owner-isolated non-business key/value storage', async () => {
    const { service } = await fixture('kv')
    service.set('plugin-a', 'settings/theme', { color: 'blue' })
    service.set('plugin-b', 'settings/theme', { color: 'red' })

    expect(service.get('plugin-a', 'settings/theme')).toEqual({ color: 'blue' })
    expect(service.list('plugin-a', 'settings/')).toEqual([
      { key: 'settings/theme', value: { color: 'blue' } },
    ])
    service.delete('plugin-a', 'settings/theme')
    expect(service.get('plugin-a', 'settings/theme')).toBeUndefined()
    service.close()
  })

  it('exports, inspects, and atomically imports the complete SQLite dataset', async () => {
    const source = await fixture('source')
    source.service.raw().prepare(`
      INSERT INTO entries (id, book_id, direction, amount_minor, currency, occurred_at, recorded_at,
        source, recorder, type, extra, schema_version, revision, voided_at, void_reason)
      VALUES ('01SOURCE', 'default', 'expense', 100, 'CNY', 1, 1, 'test', 'me', NULL, '{}', 1, 1, NULL, NULL)
    `).run()
    source.service.set('plugin-demo', 'token', { value: 42 })
    const artifact = await source.service.exportAll({ destination: join(source.dir, 'snapshot.db') })

    const target = await fixture('target')
    target.service.raw().prepare(`
      INSERT INTO entries (id, book_id, direction, amount_minor, currency, occurred_at, recorded_at,
        source, recorder, type, extra, schema_version, revision, voided_at, void_reason)
      VALUES ('01TARGET', 'default', 'income', 200, 'CNY', 2, 2, 'test', 'me', NULL, '{}', 1, 1, NULL, NULL)
    `).run()

    const plan = await target.service.inspectImport(artifact.path)
    expect(plan.compatible).toBe(true)
    const result = await target.service.importAll(artifact.path, { createSafetyBackup: true })

    expect(result.tables).toContain('entries')
    expect(result.safetyBackup).toBeTruthy()
    expect(target.service.raw().prepare('SELECT id FROM entries').all()).toEqual([{ id: '01SOURCE' }])
    expect(target.service.get('plugin-demo', 'token')).toEqual({ value: 42 })
    source.service.close()
    target.service.close()
  })

  it('rejects incompatible imports before touching current data', async () => {
    const source = await fixture('incompatible-source')
    source.service.raw().exec('ALTER TABLE storage_kv ADD COLUMN incompatible TEXT')
    const artifact = await source.service.exportAll({ destination: join(source.dir, 'incompatible.db') })

    const target = await fixture('incompatible-target')
    target.service.set('plugin-demo', 'kept', { value: 'current' })
    const plan = await target.service.inspectImport(artifact.path)

    expect(plan.compatible).toBe(false)
    await expect(target.service.importAll(artifact.path)).rejects.toThrow(/incompatible/)
    expect(target.service.get('plugin-demo', 'kept')).toEqual({ value: 'current' })
    source.service.close()
    target.service.close()
  })
})
