import { describe, expect, it } from 'vitest'
import { InMemoryEntryRepository, InMemoryMetadataStore } from '@ledger/domain'
import { createKernel } from './kernel.js'

/**
 * 零插件自洽测试——第一原则「内核自洽」的可执行证明。
 * 不装任何插件：记账、修订、作废、查询、统计全部通过。
 * 此后作为永久 CI 门禁：任何使内核依赖插件的改动立即红。
 */
describe('kernel self-sufficiency with ZERO plugins (permanent CI gate)', () => {
  it('adds, lists, revises, voids and aggregates entries without any plugin', async () => {
    const kernel = createKernel({
      repo: new InMemoryEntryRepository(),
      metaStore: new InMemoryMetadataStore(),
    })

    const added = await kernel.dispatcher.dispatch({
      command: 'entry.add',
      payload: { direction: 'expense', amountMinor: 1250, currency: 'CNY' },
      context: { source: 'cli', recorder: 'me' },
    })
    expect(added.ok).toBe(true)
    const entry = (added as { ok: true; data: any }).data
    expect(entry.amountMinor).toBe(1250)
    expect(entry.type).toBeNull()
    expect(entry.source).toBe('cli')
    expect(entry.recorder).toBe('me')

    await kernel.dispatcher.dispatch({
      command: 'entry.add',
      payload: { direction: 'income', amountMinor: 1_000_000, currency: 'CNY', type: null },
    })

    // 修订：前像快照留痕 + revision 递增
    const revised = await kernel.dispatcher.dispatch({
      command: 'entry.revise',
      payload: { id: entry.id, patch: { amountMinor: 1300 }, reason: '金额记错' },
      context: { source: 'cli', recorder: 'me' },
    })
    expect(revised.ok).toBe(true)
    expect((revised as { ok: true; data: any }).data.revision).toBe(2)
    const revisions = await kernel.dispatcher.dispatch({
      command: 'entry.revisions',
      payload: { entryId: entry.id },
    })
    const revList = (revisions as { ok: true; data: any[] }).data
    expect(revList).toHaveLength(1)
    expect(JSON.parse(revList[0].snapshot).amountMinor).toBe(1250)
    expect(revList[0].actor).toBe('me')
    expect(revList[0].source).toBe('cli')

    // 作废：软删，默认不参与统计但可查
    const voided = await kernel.dispatcher.dispatch({
      command: 'entry.void',
      payload: { id: entry.id, reason: '重复记录' },
    })
    expect(voided.ok).toBe(true)
    expect((voided as { ok: true; data: any }).data.voidedAt).not.toBeNull()

    const listed = await kernel.dispatcher.dispatch({ command: 'entry.list', payload: {} })
    expect((listed as { ok: true; data: any }).data.total).toBe(1) // 未作废的 1 条

    const listedAll = await kernel.dispatcher.dispatch({
      command: 'entry.list',
      payload: { includeVoided: true },
    })
    expect((listedAll as { ok: true; data: any }).data.total).toBe(2)

    // 统计只依赖 direction：作废剔除后 expense=0、income=10000.00
    const summary = await kernel.dispatcher.dispatch({ command: 'stats.summary', payload: {} })
    const stats = (summary as { ok: true; data: any }).data
    expect(stats.expense).toEqual({})
    expect(stats.income.CNY).toEqual({ count: 1, totalMinor: 1_000_000 })
    expect(stats.net.CNY).toBe(1_000_000)

    const monthly = await kernel.dispatcher.dispatch({ command: 'stats.monthly', payload: {} })
    expect((monthly as { ok: true; data: any[] }).data).toHaveLength(1)

    await kernel.shutdown()
  })

  it('dispatcher injects context defaults (source/recorder are not user input)', async () => {
    const kernel = createKernel({
      repo: new InMemoryEntryRepository(),
      metaStore: new InMemoryMetadataStore(),
    })
    const res = await kernel.dispatcher.dispatch({ command: 'entry.add', payload: { direction: 'expense', amountMinor: 100, currency: 'CNY' } })
    const entry = (res as { ok: true; data: any }).data
    expect(entry.source).toBe('internal')
    expect(entry.recorder).toBe('me')
  })
})
