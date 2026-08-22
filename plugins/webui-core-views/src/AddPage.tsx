import { useEffect, useState } from 'react'
import type { FieldDefDTO, TypeDefDTO } from '@ledger/webui-contract'
import { formatMoney, localInputToTs, parseAmountToMinor } from './util.js'
import { inputStyle, labelStyle, rowStyle } from './styles.js'

interface Props {
  client: { call<T = any>(command: string, payload?: unknown): Promise<T> }
}

/**
 * 记账表单：type_defs / field_defs 注册表驱动渲染——
 * enum → 下拉、date → 日期选择器、number → 数字输入。
 * 与 CLI flag 生成、MCP tool schema 同源；注册新字段，表单自动出现新控件。
 */
export function AddPage({ client }: Props) {
  const [direction, setDirection] = useState<'expense' | 'income'>('expense')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('CNY')
  const [type, setType] = useState('')
  const [occurredAt, setOccurredAt] = useState('')
  const [extra, setExtra] = useState<Record<string, string>>({})
  const [types, setTypes] = useState<TypeDefDTO[]>([])
  const [fields, setFields] = useState<FieldDefDTO[]>([])
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const loadDefs = async () => {
    const [t, f] = await Promise.all([
      client.call<TypeDefDTO[]>('type.list', {}),
      client.call<FieldDefDTO[]>('field.list', {}),
    ])
    setTypes(t)
    setFields(f)
  }

  useEffect(() => {
    void loadDefs().catch(() => undefined)
  }, [])

  const visibleFields = fields.filter((f) => !f.unavailable && (f.scope === 'both' || f.scope === direction))

  const submit = async () => {
    setMessage(null)
    try {
      const payload: Record<string, unknown> = {
        direction,
        amountMinor: parseAmountToMinor(amount, currency),
        currency,
        type: type || null,
      }
      const ts = localInputToTs(occurredAt)
      if (ts !== undefined) payload['occurredAt'] = ts
      const extraObj: Record<string, unknown> = {}
      for (const f of visibleFields) {
        const v = extra[f.key]
        if (v === undefined || v === '') continue
        extraObj[f.key] = f.valueType === 'number' ? Number(v) : f.valueType === 'boolean' ? v === 'true' : v
      }
      if (Object.keys(extraObj).length > 0) payload['extra'] = extraObj
      const entry = await client.call('entry.add', payload)
      setMessage({ ok: true, text: `已记账 ${formatMoney(entry.amountMinor, entry.currency)}（${entry.id.slice(-6)}）` })
      setAmount('')
      setExtra({})
    } catch (e: any) {
      setMessage({ ok: false, text: `[${e.code ?? 'ERROR'}] ${e.message}` })
    }
  }

  return (
    <div style={{ maxWidth: 420 }}>
      <div style={rowStyle}>
        <button
          onClick={() => setDirection('expense')}
          style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid #d4d4d8', background: direction === 'expense' ? '#27272a' : '#fff', color: direction === 'expense' ? '#fafafa' : '#18181b', cursor: 'pointer' }}
        >
          支出
        </button>
        <button
          onClick={() => setDirection('income')}
          style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid #d4d4d8', background: direction === 'income' ? '#27272a' : '#fff', color: direction === 'income' ? '#fafafa' : '#18181b', cursor: 'pointer' }}
        >
          收入
        </button>
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>金额</label>
        <input style={inputStyle} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="12.50" inputMode="decimal" />
        <select style={{ ...inputStyle, width: 90 }} value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {['CNY', 'USD', 'EUR', 'JPY', 'HKD'].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>类型</label>
        <select style={inputStyle} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">（无类型）</option>
          {types
            .filter((t) => !t.unavailable && t.direction === direction)
            .map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
        </select>
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>时间</label>
        <input style={inputStyle} type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
      </div>

      {/* 动态字段：注册新字段，这里自动出现新控件（同源动态表单） */}
      {visibleFields.map((f) => (
        <div key={f.key} style={rowStyle}>
          <label style={labelStyle}>{f.label}</label>
          {f.valueType === 'enum' ? (
            <select style={inputStyle} value={extra[f.key] ?? ''} onChange={(e) => setExtra({ ...extra, [f.key]: e.target.value })}>
              <option value="">（不填）</option>
              {(f.enumValues ?? []).map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </select>
          ) : f.valueType === 'boolean' ? (
            <select style={inputStyle} value={extra[f.key] ?? ''} onChange={(e) => setExtra({ ...extra, [f.key]: e.target.value })}>
              <option value="">（不填）</option>
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
          ) : (
            <input
              style={inputStyle}
              type={f.valueType === 'number' ? 'number' : f.valueType === 'date' ? 'date' : 'text'}
              value={extra[f.key] ?? ''}
              onChange={(e) => setExtra({ ...extra, [f.key]: e.target.value })}
            />
          )}
        </div>
      ))}

      <div style={{ ...rowStyle, justifyContent: 'flex-end' }}>
        <button onClick={() => void submit()} style={{ padding: '8px 24px', borderRadius: 8, background: '#18181b', color: '#fafafa', border: 'none', cursor: 'pointer' }}>
          记一笔
        </button>
      </div>

      {message && (
        <div style={{ padding: 12, borderRadius: 8, background: message.ok ? '#ecfdf5' : '#fef2f2', color: message.ok ? '#065f46' : '#991b1b', fontSize: 14 }}>
          {message.text}
        </div>
      )}
      <button onClick={() => void loadDefs()} style={{ marginTop: 12, background: 'none', border: 'none', color: '#71717a', cursor: 'pointer', fontSize: 12 }}>
        ↻ 刷新字段与类型（注册新字段后点击）
      </button>
    </div>
  )
}
