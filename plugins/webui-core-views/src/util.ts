/** core-views 共享小工具：金额与时间（UI 插件自包含，不依赖 shell 内部） */

const EXPONENTS: Record<string, number> = {
  CNY: 2, USD: 2, EUR: 2, GBP: 2, HKD: 2, JPY: 0, KRW: 0,
}

export function parseAmountToMinor(text: string, currency: string): number {
  const exp = EXPONENTS[currency] ?? 2
  if (!/^\d+(\.\d+)?$/.test(text.trim())) throw new Error(`金额格式不正确: ${text}`)
  const [int, frac = ''] = text.trim().split('.')
  if (frac.length > exp) throw new Error(`金额小数位超出 ${currency} 精度（${exp} 位）`)
  const padded = (frac + '0'.repeat(exp)).slice(0, exp)
  const minor = Number(int + padded)
  if (minor <= 0) throw new Error('金额必须为正数')
  return minor
}

export function formatMoney(amountMinor: number, currency: string): string {
  const exp = EXPONENTS[currency] ?? 2
  if (exp === 0) return `${currency} ${amountMinor}`
  const s = String(amountMinor).padStart(exp + 1, '0')
  return `${currency} ${s.slice(0, -exp)}.${s.slice(-exp)}`
}

export function formatTs(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** datetime-local 输入值 → epoch ms */
export function localInputToTs(v: string): number | undefined {
  if (!v) return undefined
  const t = new Date(v).getTime()
  return Number.isNaN(t) ? undefined : t
}
