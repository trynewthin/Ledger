import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, ProjectConfigStore, type Kernel } from '@ledger/kernel'
import { migrate, openDatabase, SqliteEntryRepository, SqliteMetadataStore, SqliteStorageService } from '@ledger/storage-sqlite'
import { coreTypesPlugin } from './index.js'

const closes: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closes.splice(0).map((close) => close()))
})

async function boot(): Promise<Kernel> {
  const root = await mkdtemp(join(tmpdir(), 'ledger-tags-'))
  const dataDir = join(root, '.ledger')
  await mkdir(dataDir)
  await writeFile(join(root, 'ledger.config.json'), JSON.stringify({ storage: { dataDir: './.ledger' }, plugins: {} }))
  const config = await ProjectConfigStore.open({ projectRoot: root })
  const db = openDatabase(join(dataDir, 'ledger.db'))
  migrate(db)
  const storage = new SqliteStorageService(db, join(dataDir, 'ledger.db'))
  const kernel = createKernel({
    repo: new SqliteEntryRepository(db),
    metaStore: new SqliteMetadataStore(db),
    config: { dataDir, projectRoot: root, configProvider: config, storageProvider: storage },
  })
  closes.push(async () => {
    await kernel.shutdown()
    await config.close()
    storage.close()
    await rm(root, { recursive: true, force: true })
  })
  return kernel
}

async function ok<T = any>(kernel: Kernel, command: string, payload?: unknown): Promise<T> {
  const res = await kernel.dispatcher.dispatch({ command, payload, context: { source: 'cli' } })
  if (!res.ok) throw new Error(`${command} failed: ${JSON.stringify(res.error)}`)
  return res.data as T
}

async function err(kernel: Kernel, command: string, payload?: unknown) {
  const res = await kernel.dispatcher.dispatch({ command, payload, context: { source: 'cli' } })
  expect(res.ok).toBe(false)
  return (res as { ok: false; error: { code: string } }).error
}

describe('plugin-core-types（账本标签）', () => {
  it('manages tag groups and tags with full CRUD', async () => {
    const kernel = await boot()
    await kernel.loadPlugins([coreTypesPlugin])

    const group = await ok<any>(kernel, 'tag-group.create', { name: '用途' })
    expect(await ok<any>(kernel, 'tag-group.get', { id: group.id })).toMatchObject({ name: '用途' })
    expect(await ok<any[]>(kernel, 'tag-group.list')).toMatchObject([{ id: group.id }])
    await ok(kernel, 'tag-group.update', { id: group.id, name: '项目用途' })

    const tag = await ok<any>(kernel, 'tag.create', { groupId: group.id, name: '家庭' })
    expect(await ok<any>(kernel, 'tag.get', { id: tag.id })).toMatchObject({ groupId: group.id, name: '家庭' })
    await ok(kernel, 'tag.update', { id: tag.id, name: '个人' })
    expect((await ok<any[]>(kernel, 'tag.list', { groupId: group.id }))[0]).toMatchObject({ name: '个人' })
    await ok(kernel, 'tag.delete', { id: tag.id })
    expect((await err(kernel, 'tag.get', { id: tag.id })).code).toBe('TAG_NOT_FOUND')

    await ok(kernel, 'tag-group.delete', { id: group.id })
    expect((await err(kernel, 'tag-group.get', { id: group.id })).code).toBe('TAG_GROUP_NOT_FOUND')
  })

  it('binds books only to tags and reverse-matches groups across multiple groups', async () => {
    const kernel = await boot()
    await kernel.loadPlugins([coreTypesPlugin])
    const book = await ok<any>(kernel, 'book.create', { name: '家庭账本' })
    const scene = await ok<any>(kernel, 'tag-group.create', { name: '场景' })
    const owner = await ok<any>(kernel, 'tag-group.create', { name: '归属' })
    const home = await ok<any>(kernel, 'tag.create', { groupId: scene.id, name: '家庭' })
    const mine = await ok<any>(kernel, 'tag.create', { groupId: owner.id, name: '我的' })

    const bound = await ok<any>(kernel, 'book.tag.bind', { bookId: book.id, tagIds: [home.id, mine.id] })
    expect(bound.tags.map((tag: any) => tag.id)).toEqual([home.id, mine.id])
    expect(bound.groups.map((group: any) => group.id)).toEqual([scene.id, owner.id])

    // 关联仅记录 tagId；移动标签后账本自然反查到新组，不必重写绑定。
    await ok(kernel, 'tag.update', { id: home.id, groupId: owner.id })
    const moved = await ok<any>(kernel, 'book.tag.list', { bookId: book.id })
    expect(moved.tags.find((tag: any) => tag.id === home.id)).toMatchObject({ groupId: owner.id })
    expect(moved.groups.map((group: any) => group.id)).toEqual([owner.id])

    await ok(kernel, 'book.tag.unbind', { bookId: book.id, tagIds: [mine.id] })
    expect((await ok<any>(kernel, 'book.tag.list', { bookId: book.id })).tags.map((tag: any) => tag.id)).toEqual([home.id])
  })

  it('leaves Book Core available after the tag plugin is unloaded', async () => {
    const kernel = await boot()
    await kernel.loadPlugins([coreTypesPlugin])
    const book = await ok<any>(kernel, 'book.create', { name: '可用性验证' })
    await kernel.pluginHost.unload('plugin-core-types')

    expect((await err(kernel, 'book.tag.list', { bookId: book.id })).code).toBe('SERVICE_UNAVAILABLE')
    expect(await ok<any>(kernel, 'book.get', { id: book.id })).toMatchObject({ name: '可用性验证' })
  })
})
