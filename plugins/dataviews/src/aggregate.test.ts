import { describe, expect, it } from 'vitest'
import type { EntryDTO, StatsByRecorderItem, StatsMonthlyItem } from '@ledger/webui-contract'
import {
  bucketize,
  byExtraField,
  dominantCurrency,
  filterPayload,
  monthlyRows,
  recorderBuckets,
} from './aggregate.js'

function entry(partial: Partial<EntryDTO>): EntryDTO {
  return {
    id: partial.id ?? 'e1', bookId: 'default', direction: 'expense', amountMinor: 100, currency: 'CNY',
    occurredAt: 0, recordedAt: 0, source: 'cli', recorder: 'me', type: null, extra: {},
    schemaVersion: 1, revision: 1, voidedAt: null, voidReason: null, ...partial,
  }
}

describe('dataviews 聚合（纯函数）', () => {
  it('dominantCurrency picks the currency with the largest total', () => {
    const entries = [
      entry({ amountMinor: 100, currency: 'CNY' }),
      entry({ amountMinor: 500, currency: 'CNY' }),
      entry({ amountMinor: 10, currency: 'USD' }),
    ]
    expect(dominantCurrency(entries)).toBe('CNY')
    expect(dominantCurrency([])).toBeNull()
  })

  it('bucketize groups, counts, sorts desc, filters to dominant currency, optional topN', () => {
    const entries = [
      entry({ id: '1', amountMinor: 300, type: 'food' }),
      entry({ id: '2', amountMinor: 500, type: 'transport' }),
      entry({ id: '3', amountMinor: 100, type: 'food' }),
      entry({ id: '4', amountMinor: 900, type: 'food', currency: 'USD' }), // 非主币种剔除
      entry({ id: '5', type: null }),
    ]
    const { buckets, currency } = bucketize(
      entries,
      (e) => e.type,
      (k) => (k === 'food' ? '餐饮' : k),
      1,
    )
    expect(currency).toBe('CNY')
    // 排序降序后取 top1：transport 500 > food 400（USD 的 900 已按主币种剔除）
    expect(buckets).toEqual([{ key: 'transport', label: 'transport', count: 1, totalMinor: 500 }])
  })

  it('byExtraField groups payment_platform with (未填) fallback and labels', () => {
    const entries = [
      entry({ id: '1', amountMinor: 100, extra: { payment_platform: 'alipay' } }),
      entry({ id: '2', amountMinor: 200, extra: { payment_platform: 'wechat' } }),
      entry({ id: '3', amountMinor: 300, extra: {} }),
    ]
    const { buckets, currency } = byExtraField(entries, 'payment_platform', (k) => (k === 'alipay' ? '支付宝' : k))
    expect(currency).toBe('CNY')
    expect(buckets.map((b) => [b.key, b.totalMinor])).toEqual([['(未填)', 300], ['wechat', 200], ['alipay', 100]])
    expect(buckets.find((b) => b.key === 'alipay')!.label).toBe('支付宝')
  })

  it('monthlyRows shapes stats.monthly to last N rows in dominant currency', () => {
    const monthly: StatsMonthlyItem[] = [
      { month: '2026-05', income: { CNY: { count: 1, totalMinor: 1000 } }, expense: {} },
      { month: '2026-06', income: {}, expense: { CNY: { count: 2, totalMinor: 500 } } },
      { month: '2026-07', income: { CNY: { count: 1, totalMinor: 2000 } }, expense: { CNY: { count: 1, totalMinor: 800 } } },
    ]
    const { rows, currency } = monthlyRows(monthly, 2)
    expect(currency).toBe('CNY')
    expect(rows).toEqual([
      { month: '2026-06', income: 0, expense: 500 },
      { month: '2026-07', income: 2000, expense: 800 },
    ])
  })

  it('recorderBuckets maps stats.byRecorder to display buckets', () => {
    const items: StatsByRecorderItem[] = [
      { recorder: 'me', totals: { CNY: { count: 3, totalMinor: 900 } } },
      { recorder: 'bot:x', totals: { CNY: { count: 1, totalMinor: 100 } } },
      { recorder: 'other', totals: { USD: { count: 5, totalMinor: 99 } } }, // 非主币种剔除
    ]
    const { buckets, currency } = recorderBuckets(items)
    expect(currency).toBe('CNY')
    expect(buckets).toEqual([
      { key: 'me', label: 'me', count: 3, totalMinor: 900 },
      { key: 'bot:x', label: 'bot:x', count: 1, totalMinor: 100 },
    ])
  })

  it('filterPayload maps direction and day range (start inclusive, end inclusive)', () => {
    expect(filterPayload({ direction: '', from: '', to: '' })).toEqual({})
    const p = filterPayload({ direction: 'expense', from: '2026-08-01', to: '2026-08-31' })
    expect(p['direction']).toBe('expense')
    expect(p['from']).toBe(new Date('2026-08-01T00:00:00').getTime())
    expect(p['to']).toBe(new Date('2026-08-31T00:00:00').getTime() + 24 * 60 * 60 * 1000 - 1)
    // 非法日期忽略
    expect(filterPayload({ direction: '', from: 'xx', to: '' })).toEqual({})
  })
})
