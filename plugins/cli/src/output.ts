import { minorToDecimal, parseDecimalToMinor } from '@ledger/domain'
import { CliError } from './errors.js'

const SYMBOLS: Record<string, string> = {
  CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£', HKD: 'HK$', KRW: '₩',
  TWD: 'NT$', SGD: 'S$', AUD: 'A$', CAD: 'C$', CHF: 'CHF ',
}

export function formatMoney(amountMinor: number, currency: string): string {
  const sym = SYMBOLS[currency] ?? `${currency} `
  return `${sym}${minorToDecimal(amountMinor, currency)}`
}

export function parseAmountInput(amount: string, currency: string): number {
  try {
    return parseDecimalToMinor(amount, currency)
  } catch (e) {
    throw new CliError('INVALID_AMOUNT', e instanceof Error ? e.message : String(e))
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}(:\d{2})?(:\d{2})?$/

/** 业务时间输入：'2026-08-22' | '2026-08-22 14:30' | ISO；本地时区解释 */
export function parseOccurredAtInput(input: string): number {
  if (DATE_RE.test(input)) return new Date(`${input}T00:00:00`).getTime()
  if (DATETIME_RE.test(input)) return new Date(input.replace(' ', 'T')).getTime()
  const t = Date.parse(input)
  if (!Number.isNaN(t)) return t
  throw new CliError('VALIDATION_ERROR', `无法解析时间: ${input}（支持 2026-08-22 / 2026-08-22 14:30 / ISO）`)
}

export function dayStart(input: string): number {
  if (!DATE_RE.test(input)) throw new CliError('VALIDATION_ERROR', `日期格式应为 YYYY-MM-DD: ${input}`)
  return new Date(`${input}T00:00:00`).getTime()
}

export function dayEnd(input: string): number {
  return dayStart(input) + 86_399_999
}

export function formatTs(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ')
  console.log(line(headers))
  console.log(widths.map((w) => '─'.repeat(w)).join('  '))
  for (const r of rows) console.log(line(r))
}
