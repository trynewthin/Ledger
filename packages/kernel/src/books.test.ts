import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteEntryRepository, SqliteMetadataStore, SqliteStorageService, migrate, openDatabase } from '@ledger/storage-sqlite'
import { ProjectConfigStore } from './config.js'
import { createKernel, type Kernel } from './kernel.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function boot(): Promise<{ kernel: Kernel; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ledger-books-'))
  const dataDir = join(root, '.ledger')
  await mkdir(dataDir)
  await writeFile(join(root, 'ledger.config.json'), JSON.stringify({ storage: { dataDir: './.ledger' }, plugins: { demo: { color: 'blue' } } }))
  const config = await ProjectConfigStore.open({ projectRoot: root })
  const databasePath = join(dataDir, 'ledger.db')
  const db = openDatabase(databasePath)
  migrate(db)
  const storage = new SqliteStorageService(db, databasePath)
  const kernel = createKernel({
    repo: new SqliteEntryRepository(db),
    metaStore: new SqliteMetadataStore(db),
    config: { dataDir, projectRoot: root, configProvider: config, storageProvider: storage },
  })
  cleanups.push(async () => {
    await kernel.shutdown()
    await config.close()
    storage.close()
    await rm(root, { recursive: true, force: true })
  })
  return { kernel, root }
}

async function ok<T = any>(kernel: Kernel, command: string, payload?: unknown): Promise<T> {
  const result = await kernel.dispatcher.dispatch({ command, payload, context: { source: 'test' } })
  if (!result.ok) throw new Error(`${command} failed: ${JSON.stringify(result.error)}`)
  return result.data as T
}

describe('Book Core', () => {
  it('creates, lists, switches and deletes complete project state', async () => {
    const { kernel, root } = await boot()
    await ok(kernel, 'entry.add', { direction: 'expense', amountMinor: 100, currency: 'CNY' })
    const first = await ok<any>(kernel, 'book.create', { name: '起始账本' })
    expect(await ok<any>(kernel, 'book.current')).toMatchObject({ id: first.id })

    await ok(kernel, 'entry.add', { direction: 'expense', amountMinor: 200, currency: 'CNY' })
    await writeFile(join(root, 'ledger.config.json'), JSON.stringify({ storage: { dataDir: './.ledger' }, plugins: { demo: { color: 'red' } } }))
    await kernel.config.reload?.()
    const second = await ok<any>(kernel, 'book.create', { name: '变更后账本' })
    expect((await ok<any>(kernel, 'entry.list')).total).toBe(2)

    const switched = await ok<any>(kernel, 'book.switch', { id: first.id })
    expect(switched).toMatchObject({ book: { id: first.id }, configReloaded: true, restartRequired: true })
    expect((await ok<any>(kernel, 'entry.list')).total).toBe(1)
    expect(kernel.config.get('plugins.demo.color')).toBe('blue')
    expect((await ok<any[]>(kernel, 'book.list')).map((book) => book.id)).toEqual(expect.arrayContaining([first.id, second.id]))

    const third = await ok<any>(kernel, 'book.create', { name: '当前账本副本' })
    await ok(kernel, 'book.delete', { id: second.id })
    const active = await kernel.dispatcher.dispatch({ command: 'book.delete', payload: { id: third.id } })
    expect(active).toMatchObject({ ok: false, error: { code: 'BOOK_ACTIVE' } })
    expect(JSON.parse(await readFile(join(root, '.ledger', 'books', first.id, 'state.json'), 'utf8')).version).toBe(1)
  })
})
