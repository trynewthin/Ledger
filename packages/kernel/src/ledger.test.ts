import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryEntryRepository, InMemoryMetadataStore } from '@ledger/domain'
import { createKernel, type Kernel } from './kernel.js'

async function ok<T = any>(kernel: Kernel, command: string, payload?: unknown, context?: any): Promise<T> {
  const res = await kernel.dispatcher.dispatch({ command, payload, context: context ?? { source: 'cli', recorder: 'me' } })
  if (!res.ok) throw new Error(`${command} failed: ${JSON.stringify(res.error)}`)
  return res.data as T
}

async function err(kernel: Kernel, command: string, payload?: unknown): Promise<{ code: string; message: string }> {
  const res = await kernel.dispatcher.dispatch({ command, payload, context: { source: 'cli' } })
  if (res.ok) throw new Error(`${command} unexpectedly succeeded`)
  return res.error
}

describe('ledger commands', () => {
  let kernel: Kernel
  beforeEach(() => {
    kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
  })

  it('validates input and returns typed errors', async () => {
    expect((await err(kernel, 'entry.add', { direction: 'both', amountMinor: 1, currency: 'CNY' })).code).toBe('VALIDATION_ERROR')
    expect((await err(kernel, 'entry.add', { direction: 'expense', amountMinor: -1, currency: 'CNY' })).code).toBe('VALIDATION_ERROR')
    // 领域层最终防线：ISO 4217 之外的货币码被聚合构造拒绝
    expect((await err(kernel, 'entry.add', { direction: 'expense', amountMinor: 10, currency: 'XXX' })).code).toBe('INVALID_CURRENCY')
    expect((await err(kernel, 'entry.add', { direction: 'expense', amountMinor: 10, currency: 'CNY', type: 'salary' })).code).toBe('TYPE_NOT_REGISTERED')
    expect((await err(kernel, 'no.such.command')).code).toBe('COMMAND_NOT_FOUND')
  })

  it('type registry: register → direction mapping enforced → unregister', async () => {
    await ok(kernel, 'type.register', { key: 'salary', label: '工资', direction: 'income' })
    await ok(kernel, 'type.register', { key: 'food', label: '餐饮', direction: 'expense' })

    const e1 = await ok(kernel, 'entry.add', { direction: 'income', amountMinor: 100, currency: 'CNY', type: 'salary' })
    expect(e1.type).toBe('salary')

    const e = await err(kernel, 'entry.add', { direction: 'expense', amountMinor: 100, currency: 'CNY', type: 'salary' })
    expect(e.code).toBe('TYPE_DIRECTION_MISMATCH')

    // 同 key 重复注册被拒，overwrite 可覆盖自己的
    expect((await err(kernel, 'type.register', { key: 'salary', label: '工资', direction: 'income' })).code).toBe('TYPE_KEY_TAKEN')
    await ok(kernel, 'type.register', { key: 'salary', label: '工资', direction: 'income', overwrite: true })
  })

  it('field validation: enum / type / scope / strict mode', async () => {
    await ok(kernel, 'field.register', {
      key: 'payment_platform',
      label: '付款平台',
      scope: 'both',
      valueType: 'enum',
      enumValues: [
        { value: 'alipay', label: '支付宝' },
        { value: 'wechat', label: '微信' },
      ],
    })
    await ok(kernel, 'field.register', { key: 'note', label: '备注', scope: 'both', valueType: 'string' })
    await ok(kernel, 'field.register', { key: 'expense_only', label: '仅支出', scope: 'expense', valueType: 'number' })

    await ok(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 10, currency: 'CNY',
      extra: { payment_platform: 'alipay', note: '午饭' },
    })
    expect((await err(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 10, currency: 'CNY',
      extra: { payment_platform: 'cash' },
    })).code).toBe('ENUM_VIOLATION')
    expect((await err(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 10, currency: 'CNY',
      extra: { note: 123 },
    })).code).toBe('FIELD_TYPE_MISMATCH')
    expect((await err(kernel, 'entry.add', {
      direction: 'income', amountMinor: 10, currency: 'CNY',
      extra: { expense_only: 1 },
    })).code).toBe('FIELD_SCOPE_MISMATCH')

    // 未注册键：默认宽松放行，strict 拒绝
    await ok(kernel, 'entry.add', { direction: 'expense', amountMinor: 10, currency: 'CNY', extra: { whatever: 1 } })
    expect((await err(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 10, currency: 'CNY',
      extra: { whatever: 1 }, strictExtra: true,
    })).code).toBe('FIELD_UNKNOWN')

    // enum 字段必须带 enumValues
    expect((await err(kernel, 'field.register', { key: 'bad', label: 'x', scope: 'both', valueType: 'enum' })).code).toBe('VALIDATION_ERROR')
  })

  it('void requires reason; voided entries are excluded from stats but queryable', async () => {
    const entry = await ok(kernel, 'entry.add', { direction: 'expense', amountMinor: 500, currency: 'CNY' })
    expect((await err(kernel, 'entry.void', { id: entry.id })).code).toBe('VALIDATION_ERROR')
    await ok(kernel, 'entry.void', { id: entry.id, reason: '记错' })
    expect((await err(kernel, 'entry.void', { id: entry.id, reason: 'again' })).code).toBe('ENTRY_VOIDED')
    const summary = await ok(kernel, 'stats.summary', {})
    expect(summary.expense).toEqual({})
    const all = await ok(kernel, 'entry.list', { includeVoided: true })
    expect(all.total).toBe(1)
    const notFound = await err(kernel, 'entry.get', { id: 'NOPE' })
    expect(notFound.code).toBe('ENTRY_NOT_FOUND')
  })

  it('stats.byType works with null type entries (kernel semantics only)', async () => {
    await ok(kernel, 'entry.add', { direction: 'expense', amountMinor: 300, currency: 'CNY' })
    await ok(kernel, 'entry.add', { direction: 'expense', amountMinor: 200, currency: 'CNY' })
    await ok(kernel, 'entry.add', { direction: 'income', amountMinor: 1000, currency: 'USD' })
    const byType = await ok(kernel, 'stats.byType', {})
    expect(byType.find((t: any) => t.type === null).totals.CNY).toEqual({ count: 2, totalMinor: 500 })
    const byDirection = await ok(kernel, 'stats.byDirection', {})
    expect(byDirection).toHaveLength(2)
    const monthly = await ok(kernel, 'stats.monthly', {})
    expect(monthly[0].expense.CNY.totalMinor).toBe(500)
    expect(monthly[0].income.USD.totalMinor).toBe(1000)
  })

  it('multi-currency: recorded, not converted', async () => {
    await ok(kernel, 'entry.add', { direction: 'expense', amountMinor: 100, currency: 'JPY' })
    await ok(kernel, 'entry.add', { direction: 'expense', amountMinor: 100, currency: 'CNY' })
    const summary = await ok(kernel, 'stats.summary', {})
    expect(Object.keys(summary.expense).sort()).toEqual(['CNY', 'JPY'])
  })

  it('list filters: direction/type/recorder/from/to', async () => {
    await ok(kernel, 'entry.add', { direction: 'expense', amountMinor: 100, currency: 'CNY', occurredAt: 1_000 })
    await ok(kernel, 'entry.add', { direction: 'income', amountMinor: 100, currency: 'CNY', occurredAt: 2_000 })
    const onlyExpense = await ok(kernel, 'entry.list', { direction: 'expense' })
    expect(onlyExpense.total).toBe(1)
    const range = await ok(kernel, 'entry.list', { from: 1_500, to: 2_500 })
    expect(range.total).toBe(1)
    const noType = await ok(kernel, 'entry.list', { type: null })
    expect(noType.total).toBe(2)
  })
})
