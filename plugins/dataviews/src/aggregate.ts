import type { EntryDTO, StatsByRecorderItem, StatsMonthlyItem } from '@ledger/webui-contract'

/**
 * dataviews 纯聚合函数（无 React，可单测）：
 * 通用分桶 / extra 字段维度 / 月度序列整形 / 过滤器 epoch 换算。
 */

export interface Bucket {
  key: string
  label: string
  count: number
  totalMinor: number
}

/** 主币种：金额总额最大的币种（多币种只记录不折算，图表只画主币种） */
export function dominantCurrency(entries: EntryDTO[]): string | null {
  const totals = new Map<string, number>()
  for (const e of entries) totals.set(e.currency, (totals.get(e.currency) ?? 0) + e.amountMinor)
  let best: string | null = null
  let max = -1
  for (const [cur, total] of totals) {
    if (total > max) {
      max = total
      best = cur
    }
  }
  return best
}

export function dominantCurrencyOfTotals(items: Array<Record<string, { totalMinor: number }>>): string | null {
  let best: string | null = null
  let max = -1
  for (const totals of items) {
    for (const [cur, t] of Object.entries(totals)) {
      if (t.totalMinor > max) {
        max = t.totalMinor
        best = cur
      }
    }
  }
  return best
}

/** 通用分桶：按 keyOf 分组（keyOf 返回 null 跳过），主币种过滤，按金额降序 */
export function bucketize(
  entries: EntryDTO[],
  keyOf: (e: EntryDTO) => string | null,
  labelOf?: (key: string) => string | undefined,
  topN?: number,
): { buckets: Bucket[]; currency: string | null } {
  const currency = dominantCurrency(entries)
  if (!currency) return { buckets: [], currency: null }
  const map = new Map<string, Bucket>()
  for (const e of entries) {
    if (e.currency !== currency) continue
    const key = keyOf(e)
    if (key === null) continue
    let b = map.get(key)
    if (!b) {
      b = { key, label: labelOf?.(key) ?? key, count: 0, totalMinor: 0 }
      map.set(key, b)
    }
    b.count += 1
    b.totalMinor += e.amountMinor
  }
  const buckets = [...map.values()].sort((a, b) => b.totalMinor - a.totalMinor)
  return { buckets: topN !== undefined ? buckets.slice(0, topN) : buckets, currency }
}

/** extra 字段维度（如 payment_platform）：未填归 '(未填)'（不可跳过——占比有意义） */
export function byExtraField(
  entries: EntryDTO[],
  fieldKey: string,
  labelOf?: (key: string) => string | undefined,
): { buckets: Bucket[]; currency: string | null } {
  const withFallback = entries.map((e) => {
    const v = e.extra?.[fieldKey]
    return { ...e, _key: typeof v === 'string' && v !== '' ? v : '(未填)' }
  })
  const result = bucketize(
    withFallback as EntryDTO[],
    (e) => (e as EntryDTO & { _key: string })['_key'],
    (k) => (k === '(未填)' ? '(未填)' : labelOf?.(k) ?? k),
  )
  return result
}

export interface MonthlyRow {
  month: string
  income: number
  expense: number
}

/** stats.monthly → 最近 N 月渲染行（主币种） */
export function monthlyRows(monthly: StatsMonthlyItem[], lastN = 12): { rows: MonthlyRow[]; currency: string | null } {
  const currency = dominantCurrencyOfTotals([
    ...monthly.map((m) => m.income),
    ...monthly.map((m) => m.expense),
  ])
  if (!currency) return { rows: [], currency: null }
  const rows = monthly
    .map((m) => ({
      month: m.month,
      income: m.income[currency]?.totalMinor ?? 0,
      expense: m.expense[currency]?.totalMinor ?? 0,
    }))
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .slice(-lastN)
  return { rows, currency }
}

/** stats.byRecorder → 渲染桶（主币种） */
export function recorderBuckets(items: StatsByRecorderItem[], topN?: number): { buckets: Bucket[]; currency: string | null } {
  const currency = dominantCurrencyOfTotals(items.map((i) => i.totals))
  if (!currency) return { buckets: [], currency: null }
  let buckets = items
    .map((i) => ({ key: i.recorder, label: i.recorder, count: i.totals[currency]?.count ?? 0, totalMinor: i.totals[currency]?.totalMinor ?? 0 }))
    .filter((b) => b.count > 0)
    .sort((a, b) => b.totalMinor - a.totalMinor)
  if (topN !== undefined) buckets = buckets.slice(0, topN)
  return { buckets, currency }
}

export interface ViewFilter {
  direction: '' | 'expense' | 'income'
  from: string
  to: string
}

export const EMPTY_FILTER: ViewFilter = { direction: '', from: '', to: '' }

/** 过滤器 → entry.list/stats.* 的 payload（dayStart/dayEnd 语义） */
export function filterPayload(filter: ViewFilter): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  if (filter.direction) payload['direction'] = filter.direction
  const dayStart = (d: string) => {
    const t = new Date(`${d}T00:00:00`).getTime()
    return Number.isNaN(t) ? undefined : t
  }
  const dayEnd = (d: string) => {
    const t = new Date(`${d}T00:00:00`).getTime()
    return Number.isNaN(t) ? undefined : t + 24 * 60 * 60 * 1000 - 1
  }
  const from = filter.from ? dayStart(filter.from) : undefined
  const to = filter.to ? dayEnd(filter.to) : undefined
  if (from !== undefined) payload['from'] = from
  if (to !== undefined) payload['to'] = to
  return payload
}
