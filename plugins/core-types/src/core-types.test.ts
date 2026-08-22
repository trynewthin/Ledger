import { describe, expect, it } from 'vitest'
import { InMemoryEntryRepository, InMemoryMetadataStore } from '@ledger/domain'
import { createKernel } from '@ledger/kernel'
import { coreTypesPlugin } from './index.js'

async function ok<T = any>(kernel: ReturnType<typeof createKernel>, command: string, payload?: unknown): Promise<T> {
  const res = await kernel.dispatcher.dispatch({ command, payload, context: { source: 'cli' } })
  if (!res.ok) throw new Error(`${command} failed: ${JSON.stringify(res.error)}`)
  return res.data as T
}

async function err(kernel: ReturnType<typeof createKernel>, command: string, payload?: unknown) {
  const res = await kernel.dispatcher.dispatch({ command, payload, context: { source: 'cli' } })
  expect(res.ok).toBe(false)
  return (res as { ok: false; error: any }).error
}

describe('plugin-core-types', () => {
  it('registers basic types on activate; type validation takes effect', async () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    await kernel.loadPlugins([coreTypesPlugin])

    const types = await ok(kernel, 'type.list', {})
    expect(types.map((t: any) => t.key)).toContain('food')
    expect(types.find((t: any) => t.key === 'food').icon).toBe('utensils')

    const entry = await ok(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 2500, currency: 'CNY', type: 'food',
    })
    expect(entry.type).toBe('food')

    expect((await err(kernel, 'entry.add', {
      direction: 'income', amountMinor: 100, currency: 'CNY', type: 'food',
    })).code).toBe('TYPE_DIRECTION_MISMATCH')
    expect((await err(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 100, currency: 'CNY', type: 'nope',
    })).code).toBe('TYPE_NOT_REGISTERED')
  })

  it('unloading the plugin keeps data valid and stats correct (数据自包含)', async () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    await kernel.loadPlugins([coreTypesPlugin])
    const entry = await ok(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 2500, currency: 'CNY', type: 'food',
    })

    await kernel.pluginHost.unload('plugin-core-types')

    // 类型反注册：新账不能用该 type，但历史数据仍在、统计仍然正确
    expect((await err(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 100, currency: 'CNY', type: 'food',
    })).code).toBe('TYPE_NOT_REGISTERED')

    const stored = await ok(kernel, 'entry.get', { id: entry.id })
    expect(stored.type).toBe('food') // 值冗余落在行上
    expect(stored.amountMinor).toBe(2500)

    const byType = await ok(kernel, 'stats.byType', {})
    expect(byType.find((t: any) => t.type === 'food').totals.CNY.totalMinor).toBe(2500)
    const summary = await ok(kernel, 'stats.summary', {})
    expect(summary.expense.CNY.totalMinor).toBe(2500) // 统计只依赖 direction

    // 重新装载：类型恢复
    await kernel.loadPlugins([coreTypesPlugin])
    const types = await ok(kernel, 'type.list', {})
    expect(types.map((t: any) => t.key)).toContain('food')
  })
})
