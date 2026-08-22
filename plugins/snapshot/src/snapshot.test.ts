import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createKernel, type Kernel } from '@ledger/kernel'
import { migrate, openDatabase, SqliteEntryRepository, SqliteMetadataStore } from '@ledger/storage-sqlite'
import { snapshotPlugin } from './index.js'

/** 与入口装配同构：sqlite 内核 + 'db' 服务 */
function bootKernel(): { kernel: Kernel; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'ledger-snap-'))
  const db = openDatabase(join(home, 'ledger.db'))
  migrate(db)
  const kernel = createKernel({
    repo: new SqliteEntryRepository(db),
    metaStore: new SqliteMetadataStore(db),
    config: { dataDir: home },
  })
  kernel.services.provide('db', db, 'entry')
  return { kernel, home }
}

async function ok<T = any>(kernel: Kernel, command: string, payload?: unknown): Promise<T> {
  const res = await kernel.dispatcher.dispatch({ command, payload, context: { source: 'cli' } })
  if (!res.ok) throw new Error(`${command} failed: ${JSON.stringify(res.error)}`)
  return res.data as T
}

async function errCode(kernel: Kernel, command: string, payload?: unknown): Promise<string> {
  const res = await kernel.dispatcher.dispatch({ command, payload, context: { source: 'cli' } })
  if (res.ok) throw new Error(`expected ${command} to fail`)
  return (res as { ok: false; error: { code: string } }).error.code
}

describe('plugin-snapshot', () => {
  const homes: string[] = []
  afterAll(() => {
    for (const h of homes) rmSync(h, { recursive: true, force: true })
  })

  it('full snapshot: create → 记几笔 → restore → 数据回到快照点（注册表同回迁）', async () => {
    const { kernel, home } = bootKernel()
    homes.push(home)
    await kernel.loadPlugins([snapshotPlugin])

    await ok(kernel, 'type.register', { key: 'food', label: '餐饮', direction: 'expense' })
    await ok(kernel, 'entry.add', { direction: 'expense', amountMinor: 2500, currency: 'CNY', type: 'food' })
    await ok(kernel, 'entry.add', { direction: 'income', amountMinor: 900000, currency: 'CNY' })

    const snap = await ok<{ file: string; kind: string; path: string }>(kernel, 'snapshot.create', {})
    expect(snap.kind).toBe('full')

    // 快照后新数据
    await ok(kernel, 'entry.add', { direction: 'expense', amountMinor: 9999, currency: 'CNY', type: 'food' })
    await ok(kernel, 'type.register', { key: 'later-type', label: '后注册', direction: 'expense' })
    expect((await ok(kernel, 'entry.list', {})).total).toBe(3)

    const restored = await ok<{ entriesAffected: number }>(kernel, 'snapshot.restore', { file: snap.file })
    expect(restored.entriesAffected).toBe(2)

    // 回到快照点：条目数与内容
    const list = await ok<{ items: any[]; total: number }>(kernel, 'entry.list', { includeVoided: true })
    expect(list.total).toBe(2)
    expect(list.items.every((e) => e.amountMinor !== 9999)).toBe(true)
    const summary = await ok(kernel, 'stats.summary', {})
    expect(summary.expense.CNY.totalMinor).toBe(2500)

    // type_defs 整表替换：后注册的类型消失、快照时的类型在（注册表已重载）
    const types = await ok(kernel, 'type.list', {})
    expect(types.some((t: any) => t.key === 'food')).toBe(true)
    expect(types.some((t: any) => t.key === 'later-type')).toBe(false)
    // 被回迁删除的类型立即重新生效
    const again = await ok(kernel, 'entry.add', { direction: 'expense', amountMinor: 100, currency: 'CNY', type: 'food' })
    expect(again.type).toBe('food')
    await kernel.shutdown()
  })

  it('book snapshot: JSON 导出（entries + revisions + 引用定义）→ 修改后回迁 upsert', async () => {
    const { kernel, home } = bootKernel()
    homes.push(home)
    await kernel.loadPlugins([snapshotPlugin])

    await ok(kernel, 'type.register', { key: 'coffee', label: '咖啡', direction: 'expense' })
    await ok(kernel, 'field.register', { key: 'payment_platform', label: '付款平台', scope: 'both', valueType: 'enum', enumValues: [{ value: 'alipay', label: '支付宝' }] })
    const e1 = await ok<any>(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 1800, currency: 'CNY', type: 'coffee', extra: { payment_platform: 'alipay' },
    })
    await ok(kernel, 'entry.revise', { id: e1.id, patch: { amountMinor: 2000 }, reason: '记错' })
    // 另一账本的条目不应进入 default 账本快照
    await ok(kernel, 'entry.add', { direction: 'expense', amountMinor: 500, currency: 'CNY', bookId: 'travel' })

    const snap = await ok<{ file: string; kind: string; bookId?: string }>(kernel, 'snapshot.create', { scope: 'book' })
    expect(snap).toMatchObject({ kind: 'book', bookId: 'default' })

    // 快照后：改金额 + 再记一笔
    await ok(kernel, 'entry.revise', { id: e1.id, patch: { amountMinor: 3000 }, reason: '又改' })
    await ok(kernel, 'entry.add', { direction: 'expense', amountMinor: 700, currency: 'CNY', type: 'coffee' })

    const restored = await ok<{ entriesAffected: number }>(kernel, 'snapshot.restore', { file: snap.file })
    expect(restored.entriesAffected).toBe(1)

    // 原 id 条目回到快照值（revision 回到快照时的 2），快照后新增的仍在（upsert 不清库）
    const back = await ok<any>(kernel, 'entry.get', { id: e1.id })
    expect(back.amountMinor).toBe(2000)
    expect(back.revision).toBe(2)
    const list = await ok<{ total: number }>(kernel, 'entry.list', { bookId: 'default' })
    expect(list.total).toBe(2)
    const travel = await ok<{ total: number }>(kernel, 'entry.list', { bookId: 'travel' })
    expect(travel.total).toBe(1)
    // 修订历史随快照回迁（revision 1 的前像在快照后已被续写——此处验证快照内的 revision 链完整）
    const revs = await ok<any[]>(kernel, 'entry.revisions', { entryId: e1.id })
    expect(revs.length).toBeGreaterThanOrEqual(1)
    await kernel.shutdown()
  })

  it('list + degrade: 不在场 SERVICE_UNAVAILABLE；restore 未知文件 SNAPSHOT_NOT_FOUND', async () => {
    const { kernel, home } = bootKernel()
    homes.push(home)

    expect(await errCode(kernel, 'snapshot.list')).toBe('SERVICE_UNAVAILABLE')
    expect(await errCode(kernel, 'snapshot.create')).toBe('SERVICE_UNAVAILABLE')

    await kernel.loadPlugins([snapshotPlugin])
    await ok(kernel, 'entry.add', { direction: 'expense', amountMinor: 100, currency: 'CNY' })
    await ok(kernel, 'snapshot.create', {})
    const list = await ok<any[]>(kernel, 'snapshot.list')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ kind: 'full' })

    expect(await errCode(kernel, 'snapshot.restore', { file: 'full-20990101-000000.db' })).toBe('SNAPSHOT_NOT_FOUND')
    // 路径穿越收敛到 basename
    expect(await errCode(kernel, 'snapshot.restore', { file: '../../etc/passwd' })).toBe('SNAPSHOT_NOT_FOUND')
    await kernel.shutdown()
  })
})
