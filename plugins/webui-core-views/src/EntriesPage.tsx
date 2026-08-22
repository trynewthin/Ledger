import { useEffect, useState } from 'react'
import type { FieldDefDTO, TypeDefDTO } from '@ledger/webui-contract'
import { formatMoney, formatTs } from './util.js'
import { inputStyle, tableStyle, tdStyle, thStyle } from './styles.js'

interface Props {
  client: { call<T = any>(command: string, payload?: unknown): Promise<T> }
}

/** 流水列表 + 详情（含修订历史）+ 作废 */
export function EntriesPage({ client }: Props) {
  const [items, setItems] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [types, setTypes] = useState<TypeDefDTO[]>([])
  const [fields, setFields] = useState<FieldDefDTO[]>([])
  const [direction, setDirection] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [selected, setSelected] = useState<any | null>(null)
  const [revisions, setRevisions] = useState<any[]>([])
  const [voidReason, setVoidReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    const filter: Record<string, unknown> = {}
    if (direction) filter['direction'] = direction
    if (typeFilter) filter['type'] = typeFilter
    const res = await client.call<{ items: any[]; total: number }>('entry.list', filter)
    setItems(res.items)
    setTotal(res.total)
  }

  useEffect(() => {
    void refresh().catch((e) => setError(String(e.message)))
    void client.call<TypeDefDTO[]>('type.list', {}).then(setTypes).catch(() => undefined)
    void client.call<FieldDefDTO[]>('field.list', {}).then(setFields).catch(() => undefined)
  }, [])

  const typeLabel = (key: string | null) => (key === null ? '—' : (types.find((t) => t.key === key)?.label ?? key))

  const openDetail = async (id: string) => {
    setSelected(null)
    setError(null)
    try {
      const [entry, revs] = await Promise.all([
        client.call('entry.get', { id }),
        client.call('entry.revisions', { entryId: id }),
      ])
      setSelected(entry)
      setRevisions(revs)
    } catch (e: any) {
      setError(`[${e.code}] ${e.message}`)
    }
  }

  const voidEntry = async () => {
    if (!selected || !voidReason.trim()) return
    try {
      await client.call('entry.void', { id: selected.id, reason: voidReason.trim() })
      setVoidReason('')
      await refresh()
      await openDetail(selected.id)
    } catch (e: any) {
      setError(`[${e.code}] ${e.message}`)
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 24 }}>
      <div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <select style={{ ...inputStyle, maxWidth: 130 }} value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="">全部方向</option>
            <option value="expense">支出</option>
            <option value="income">收入</option>
          </select>
          <select style={{ ...inputStyle, maxWidth: 160 }} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">全部类型</option>
            {types.filter((t) => !t.unavailable).map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
          <button onClick={() => void refresh()} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #d4d4d8', background: '#fff', cursor: 'pointer' }}>
            查询
          </button>
        </div>

        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>时间</th>
              <th style={thStyle}>方向</th>
              <th style={thStyle}>金额</th>
              <th style={thStyle}>类型</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr
                key={e.id}
                onClick={() => void openDetail(e.id)}
                style={{ cursor: 'pointer', background: selected?.id === e.id ? '#f4f4f5' : undefined }}
              >
                <td style={tdStyle}>{formatTs(e.occurredAt)}</td>
                <td style={{ ...tdStyle, color: e.direction === 'income' ? '#059669' : '#dc2626' }}>
                  {e.direction === 'income' ? '收入' : '支出'}
                </td>
                <td style={tdStyle}>{formatMoney(e.amountMinor, e.currency)}</td>
                <td style={tdStyle}>{typeLabel(e.type)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 8, color: '#71717a', fontSize: 13 }}>共 {total} 条（默认不含已作废）</div>
        {error && <div style={{ color: '#dc2626', marginTop: 8, fontSize: 13 }}>{error}</div>}
      </div>

      <div>
        {selected ? (
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>详情（revision {selected.revision}）</h3>
            <table style={tableStyle}>
              <tbody>
                {[
                  ['ID', selected.id],
                  ['金额', formatMoney(selected.amountMinor, selected.currency)],
                  ['方向', selected.direction === 'income' ? '收入' : '支出'],
                  ['类型', typeLabel(selected.type)],
                  ['业务时间', formatTs(selected.occurredAt)],
                  ['入库时间', formatTs(selected.recordedAt)],
                  ['来源', `${selected.source} / ${selected.recorder}`],
                  ...Object.entries(selected.extra ?? {}).map(([k, v]) => [k, String(v)] as [string, string]),
                  ['状态', selected.voidedAt ? `已作废：${selected.voidReason}` : '在册'],
                ].map(([k, v]) => (
                  <tr key={k}>
                    <td style={{ ...tdStyle, color: '#71717a', width: 90 }}>{k}</td>
                    <td style={tdStyle}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {revisions.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <h4 style={{ fontSize: 13, color: '#71717a' }}>修订历史（{revisions.length}）</h4>
                {revisions.map((r, i) => (
                  <div key={r.id} style={{ fontSize: 13, color: '#52525b', padding: '4px 0', borderBottom: '1px solid #f4f4f5' }}>
                    #{i + 1} {formatTs(r.revisedAt)} · {r.actor} via {r.source} · {r.reason ?? '（无原因）'}
                  </div>
                ))}
              </div>
            )}

            {!selected.voidedAt && (
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <input style={inputStyle} placeholder="作废原因" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
                <button onClick={() => void voidEntry()} style={{ padding: '8px 16px', borderRadius: 8, background: '#dc2626', color: '#fff', border: 'none', cursor: 'pointer' }}>
                  作废
                </button>
              </div>
            )}
          </div>
        ) : (
          <div style={{ color: '#a1a1aa', fontSize: 14 }}>点击左侧条目查看详情</div>
        )}
      </div>
    </div>
  )
}
