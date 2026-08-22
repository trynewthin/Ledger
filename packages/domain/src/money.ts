import { DomainError } from './errors.js'

/** 常用 ISO 4217 代码 -> 最小单位小数位（多币种只记录不折算） */
export const CURRENCIES: Readonly<Record<string, number>> = Object.freeze({
  CNY: 2, USD: 2, EUR: 2, GBP: 2, HKD: 2, TWD: 2, SGD: 2, AUD: 2, CAD: 2,
  CHF: 2, SEK: 2, NOK: 2, DKK: 2, NZD: 2, THB: 2, MYR: 2, PHP: 2, IDR: 2,
  VND: 0, KRW: 0, JPY: 0, INR: 2, RUB: 2, BRL: 2, MXN: 2, ZAR: 2, AED: 2,
})

export interface Money {
  readonly amountMinor: number
  readonly currency: string
}

export function isSupportedCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code.toUpperCase())
}

export function currencyExponent(code: string): number {
  return CURRENCIES[code.toUpperCase()]
}

/** Money 值对象构造：金额为正整数（最小货币单位），方向由 direction 表达，不用负数 */
export function money(amountMinor: number, currency: string): Money {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new DomainError('INVALID_AMOUNT', `amountMinor must be a positive integer, got ${amountMinor}`)
  }
  const upper = currency.toUpperCase()
  if (!isSupportedCurrency(upper)) {
    throw new DomainError('INVALID_CURRENCY', `unsupported currency: ${currency}`)
  }
  return Object.freeze({ amountMinor, currency: upper })
}

/** '12.50' + CNY -> 1250；'100' + JPY -> 100。小数位超出货币精度即拒绝 */
export function parseDecimalToMinor(input: string | number, currency: string): number {
  const exp = currencyExponent(currency)
  const text = typeof input === 'number' ? String(input) : input.trim()
  if (!/^\d+(\.\d+)?$/.test(text) || text === '') {
    throw new DomainError('INVALID_AMOUNT', `invalid decimal amount: ${input}`)
  }
  const [intPart, fracPart = ''] = text.split('.')
  if (fracPart.length > exp) {
    throw new DomainError(
      'INVALID_AMOUNT',
      `amount ${text} exceeds ${exp} decimal places of ${currency.toUpperCase()}`,
    )
  }
  const padded = (fracPart + '0'.repeat(exp)).slice(0, exp)
  const minor = Number(intPart + padded)
  if (minor <= 0) throw new DomainError('INVALID_AMOUNT', `amount must be positive: ${input}`)
  return minor
}

/** 1250 + CNY -> '12.50'（展示用） */
export function minorToDecimal(amountMinor: number, currency: string): string {
  const exp = currencyExponent(currency)
  if (exp === 0) return String(amountMinor)
  const s = String(amountMinor).padStart(exp + 1, '0')
  return `${s.slice(0, -exp)}.${s.slice(-exp)}`
}
