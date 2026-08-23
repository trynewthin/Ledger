import { useEffect, useState } from 'react'
import type { EntryDTO, FieldDefDTO, LedgerClient, StatsByRecorderItem, StatsMonthlyItem, TypeDefDTO } from '@ledger/webui-contract'
import {
  byExtraField,
  bucketize,
  EMPTY_FILTER,
  filterPayload,
  monthlyRows,
  recorderBuckets,
  type Bucket,
  type ViewFilter,
} from './aggregate.js'

/**
 * 概览页数据视图（纯 div/CSS 条形，不引图表库）。
 * 数据全部经统一调用协议（stats.* / entry.list / type.list / field.list），注册表同源。
 */

const GREEN = '#059669'
const RED = '#dc2626'
const INDIGO = '#6366f1'

const EXPONENTS: Record<string, number> = { CNY: 2, USD: 2, EUR: 2, GBP: 2, HKD: 2, JPY: 0, KRW: 0 }

function formatMoney(amountMinor: number, currency: string): string {
  const exp = EXPONENTS[currency] ?? 2
  if (exp === 0) return `${currency} ${amountMinor}`
  const s = String(amountMinor).padStart(exp + 1, '0')
  return `${currency} ${s.slice(0, -exp)}.${s.slice(-exp)}`
}

const boxStyle: React.CSSProperties = { fontSize: 13 }
const titleStyle: React.CSSProperties = { fontSize: 14, fontWeight: 600, marginBottom: 10 }
const noteStyle: React.CSSProperties = { color: '#a1a1aa', fontSize: 12, padding: '12px 0' }
const selectStyle: React.CSSProperties = {
  padding: '3px 6px', borderRadius: 6, border: '1px solid #d4d4d8', fontSize: 12, background: '#fff', maxWidth: 110,
}
const dateStyle: React.CSSProperties = {
  padding: '3px 6px', borderRadius: 6, border: '1px solid #d4d4d8', fontSize: 12, background: '#fff',
}

function FilterBar({ filter, onChange, onRefresh }: {
  filter: ViewFilter
  onChange: (f: ViewFilter) => void
  onRefresh: () => void
}) {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      <select style={selectStyle} value={filter.direction} onChange={(e) => onChange({ ...filter, direction: e.target.value as ViewFilter['direction'] })}>
        <option value="">全部方向</option>
        <option value="expense">支出</option>
        <option value="income">收入</option>
      </select>
      <input style={dateStyle} type="date" value={filter.from} onChange={(e) => onChange({ ...filter, from: e.target.value })} />
      <span style={{ color: '#a1a1aa' }}>~</span>
      <input style={dateStyle} type="date" value={filter.to} onChange={(e) => onChange({ ...filter, to: e.target.value })} />
      <button onClick={onRefresh} style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid #d4d4d8', background: '#fff', fontSize: 12, cursor: 'pointer' }}>
        查询
      </button>
    </div>
  )
}

/** 横向条形列表（金额占比） */
function BarList({ buckets, currency, color }: { buckets: Bucket[]; currency: string | null; color: string }) {
  if (buckets.length === 0 || !currency) return <div style={noteStyle}>（暂无数据）</div>
  const max = Math.max(...buckets.map((b) => b.totalMinor), 1)
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {buckets.map((b) => (
        <div key={b.key} style={{ display: 'grid', gridTemplateColumns: '72px 1fr auto', gap: 8, alignItems: 'center' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.label}>{b.label}</span>
          <div style={{ background: '#f4f4f5', borderRadius: 4, height: 14, overflow: 'hidden' }}>
            <div style={{ width: `${(b.totalMinor / max) * 100}%`, background: color, height: '100%', borderRadius: 4 }} />
          </div>
          <span style={{ color: '#52525b', whiteSpace: 'nowrap' }}>
            {formatMoney(b.totalMinor, currency)} <span style={{ color: '#a1a1aa' }}>({b.count})</span>
          </span>
        </div>
      ))}
    </div>
  )
}

/** 月度趋势：每月份收/支双柱（纯 CSS 高度） */
function MonthlyBars({ rows, currency }: { rows: Array<{ month: string; income: number; expense: number }>; currency: string | null }) {
  if (rows.length === 0 || !currency) return <div style={noteStyle}>（暂无数据）</div>
  const max = Math.max(...rows.flatMap((r) => [r.income, r.expense]), 1)
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 110 }}>
        {rows.map((r) => (
          <div
            key={r.month}
            style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 2 }}
            title={`${r.month} 收 ${formatMoney(r.income, currency)} / 支 ${formatMoney(r.expense, currency)}`}
          >
            <div style={{ flex: 1, background: GREEN, height: `${Math.max((r.income / max) * 100, r.income > 0 ? 2 : 0)}%`, borderRadius: '3px 3px 0 0', minHeight: r.income > 0 ? 2 : 0 }} />
            <div style={{ flex: 1, background: RED, height: `${Math.max((r.expense / max) * 100, r.expense > 0 ? 2 : 0)}%`, borderRadius: '3px 3px 0 0', minHeight: r.expense > 0 ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        {rows.map((r) => (
          <div key={r.month} style={{ flex: 1, textAlign: 'center', color: '#71717a', fontSize: 11, overflow: 'hidden' }}>
            {r.month.slice(2)}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 6, fontSize: 12, color: '#71717a' }}>
        <span style={{ color: GREEN }}>■ 收入</span> <span style={{ color: RED }}>■ 支出</span>（{currency}）
      </div>
    </div>
  )
}

interface WidgetProps {
  client: LedgerClient
}

export function MonthlyTrendWidget({ client }: WidgetProps) {
  const [rows, setRows] = useState<Array<{ month: string; income: number; expense: number }>>([])
  const [currency, setCurrency] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void client
      .call<StatsMonthlyItem[]>('stats.monthly', {})
      .then((monthly) => {
        const shaped = monthlyRows(monthly, 12)
        setRows(shaped.rows)
        setCurrency(shaped.currency)
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true))
  }, [])

  return (
    <div style={boxStyle}>
      <div style={titleStyle}>月度趋势（近 12 月）</div>
      {loaded ? <MonthlyBars rows={rows} currency={currency} /> : <div style={noteStyle}>加载中…</div>}
    </div>
  )
}

export function TypeBreakdownWidget({ client }: WidgetProps) {
  const [state, setState] = useState<{ buckets: Bucket[]; currency: string | null }>({ buckets: [], currency: null })
  const [filter, setFilter] = useState<ViewFilter>(EMPTY_FILTER)
  const [pending, setPending] = useState(EMPTY_FILTER)
  const [loaded, setLoaded] = useState(false)

  const refresh = async (f: ViewFilter) => {
    const [items, types] = await Promise.all([
      client.call<Array<{ type: string | null; direction: string; totals: Record<string, { totalMinor: number; count: number }> }>>('stats.byType', filterPayload(f)),
      client.call<TypeDefDTO[]>('type.list', {}),
    ])
    const labels = new Map(types.map((t) => [t.key, t.label]))
    const entries = items.map((i) => ({
      id: i.type ?? '', direction: i.direction as EntryDTO['direction'], amountMinor: Object.values(i.totals)[0]?.totalMinor ?? 0,
      currency: Object.keys(i.totals)[0] ?? '', occurredAt: 0, recordedAt: 0, source: '', recorder: '', type: i.type,
      extra: {}, schemaVersion: 1, revision: 1, voidedAt: null, voidReason: null,
    }))
    setState(bucketize(entries, (e) => e.type, (k) => labels.get(k) ?? k, 8))
  }

  useEffect(() => {
    void refresh(filter).catch(() => undefined).finally(() => setLoaded(true))
  }, [])

  return (
    <div style={boxStyle}>
      <div style={titleStyle}>类型分布（Top 8）</div>
      <FilterBar filter={pending} onChange={setPending} onRefresh={() => { setFilter(pending); void refresh(pending).catch(() => undefined) }} />
      {loaded ? <BarList buckets={state.buckets} currency={state.currency} color={filter.direction === 'income' ? GREEN : RED} /> : <div style={noteStyle}>加载中…</div>}
    </div>
  )
}

export function PlatformBreakdownWidget({ client }: WidgetProps) {
  const [state, setState] = useState<{ buckets: Bucket[]; currency: string | null }>({ buckets: [], currency: null })
  const [filter, setFilter] = useState<ViewFilter>(EMPTY_FILTER)
  const [pending, setPending] = useState(EMPTY_FILTER)
  const [loaded, setLoaded] = useState(false)

  const refresh = async (f: ViewFilter) => {
    const [res, fields] = await Promise.all([
      client.call<{ items: EntryDTO[] }>('entry.list', { ...filterPayload(f), limit: 1000 }),
      client.call<FieldDefDTO[]>('field.list', {}),
    ])
    const platform = fields.find((x) => x.key === 'payment_platform')
    const labels = new Map((platform?.enumValues ?? []).map((v) => [v.value, v.label]))
    setState(byExtraField(res.items, 'payment_platform', (k) => labels.get(k) ?? k))
  }

  useEffect(() => {
    void refresh(filter).catch(() => undefined).finally(() => setLoaded(true))
  }, [])

  return (
    <div style={boxStyle}>
      <div style={titleStyle}>付款平台分布</div>
      <FilterBar filter={pending} onChange={setPending} onRefresh={() => { setFilter(pending); void refresh(pending).catch(() => undefined) }} />
      {loaded ? <BarList buckets={state.buckets} currency={state.currency} color={INDIGO} /> : <div style={noteStyle}>加载中…</div>}
      <div style={{ marginTop: 6, fontSize: 11, color: '#a1a1aa' }}>经 extra.payment_platform 聚合（注册该字段并写入数据后有效）</div>
    </div>
  )
}

export function RecorderBreakdownWidget({ client }: WidgetProps) {
  const [state, setState] = useState<{ buckets: Bucket[]; currency: string | null }>({ buckets: [], currency: null })
  const [filter, setFilter] = useState<ViewFilter>(EMPTY_FILTER)
  const [pending, setPending] = useState(EMPTY_FILTER)
  const [loaded, setLoaded] = useState(false)

  const refresh = async (f: ViewFilter) => {
    const items = await client.call<StatsByRecorderItem[]>('stats.byRecorder', filterPayload(f))
    setState(recorderBuckets(items, 8))
  }

  useEffect(() => {
    void refresh(filter).catch(() => undefined).finally(() => setLoaded(true))
  }, [])

  return (
    <div style={boxStyle}>
      <div style={titleStyle}>记录者分布（Top 8）</div>
      <FilterBar filter={pending} onChange={setPending} onRefresh={() => { setFilter(pending); void refresh(pending).catch(() => undefined) }} />
      {loaded ? <BarList buckets={state.buckets} currency={state.currency} color={filter.direction === 'income' ? GREEN : RED} /> : <div style={noteStyle}>加载中…</div>}
      <div style={{ marginTop: 6, fontSize: 11, color: '#a1a1aa' }}>多身份协同（plugin-user）场景；recorder 值冗余于每行</div>
    </div>
  )
}
