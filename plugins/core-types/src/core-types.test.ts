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

describe('plugin-core-types（完全体）', () => {
  it('registers hierarchical types with parentKey and icons; small types usable on entries', async () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    await kernel.loadPlugins([coreTypesPlugin])

    const types = await ok(kernel, 'type.list', {})
    const food = types.find((t: any) => t.key === 'food')
    const coffee = types.find((t: any) => t.key === 'food-coffee')
    expect(food).toMatchObject({ label: '餐饮', direction: 'expense', parentKey: null, icon: 'utensils' })
    expect(coffee).toMatchObject({ parentKey: 'food', icon: 'coffee' })
    // 新增大类：人情 / 教育
    expect(types.find((t: any) => t.key === 'social').parentKey).toBeNull()
    expect(types.find((t: any) => t.key === 'education-course').parentKey).toBe('education')

    // 小类型记账 + byType 聚合正常
    const entry = await ok(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 1800, currency: 'CNY', type: 'food-coffee',
    })
    expect(entry.type).toBe('food-coffee')
    const byType = await ok(kernel, 'stats.byType', {})
    expect(byType.find((t: any) => t.type === 'food-coffee').totals.CNY.totalMinor).toBe(1800)

    expect((await err(kernel, 'entry.add', {
      direction: 'income', amountMinor: 100, currency: 'CNY', type: 'food-coffee',
    })).code).toBe('TYPE_DIRECTION_MISMATCH')
  })

  it('registers payment_platform enum field; enforced on entries, sibling to CLI flag / MCP schema', async () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    await kernel.loadPlugins([coreTypesPlugin])

    const fields = await ok(kernel, 'field.list', {})
    const platform = fields.find((f: any) => f.key === 'payment_platform')
    expect(platform).toMatchObject({ label: '付款平台', scope: 'both', valueType: 'enum' })
    expect(platform.enumValues.map((v: any) => v.value)).toEqual(['alipay', 'wechat', 'bank', 'cash'])

    const entry = await ok(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 2500, currency: 'CNY', type: 'food', extra: { payment_platform: 'alipay' },
    })
    expect(entry.extra).toEqual({ payment_platform: 'alipay' })

    expect((await err(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 100, currency: 'CNY', extra: { payment_platform: 'crypto' },
    })).code).toBe('ENUM_VIOLATION')
  })

  it('unloading the plugin keeps data valid and stats correct (数据自包含)', async () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    await kernel.loadPlugins([coreTypesPlugin])
    const entry = await ok(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 2500, currency: 'CNY', type: 'food',
      extra: { payment_platform: 'wechat' },
    })

    await kernel.pluginHost.unload('plugin-core-types')

    // 类型与字段反注册：新账被拒，但历史数据仍在、统计仍然正确
    expect((await err(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 100, currency: 'CNY', type: 'food',
    })).code).toBe('TYPE_NOT_REGISTERED')
    // extra 校验失去定义：默认放行（宽松模式），值冗余不失效
    const kept = await ok(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 100, currency: 'CNY', extra: { payment_platform: 'alipay' },
    })
    expect(kept.extra).toEqual({ payment_platform: 'alipay' })

    const stored = await ok(kernel, 'entry.get', { id: entry.id })
    expect(stored.type).toBe('food')
    expect(stored.extra).toEqual({ payment_platform: 'wechat' })

    const byType = await ok(kernel, 'stats.byType', {})
    expect(byType.find((t: any) => t.type === 'food').totals.CNY.totalMinor).toBe(2500)
    const summary = await ok(kernel, 'stats.summary', {})
    expect(summary.expense.CNY.totalMinor).toBe(2600) // 统计只依赖 direction

    // 重新装载：类型与字段恢复
    await kernel.loadPlugins([coreTypesPlugin])
    expect((await ok(kernel, 'type.list', {})).some((t: any) => t.key === 'food-coffee')).toBe(true)
    expect((await ok(kernel, 'field.list', {})).some((f: any) => f.key === 'payment_platform')).toBe(true)
  })
})
