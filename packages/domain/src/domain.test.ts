import { describe, expect, it } from 'vitest'
import {
  CURRENCIES,
  isSupportedCurrency,
  minorToDecimal,
  money,
  parseDecimalToMinor,
} from './money.js'
import { applyPatch, createEntry, voidEntry } from './entry.js'
import { DomainError } from './errors.js'
import { ulid } from './ulid.js'

describe('money', () => {
  it('constructs with positive minor units and known currency', () => {
    const m = money(1250, 'cny')
    expect(m.amountMinor).toBe(1250)
    expect(m.currency).toBe('CNY')
  })

  it('rejects non-positive or fractional amounts', () => {
    expect(() => money(0, 'CNY')).toThrow(DomainError)
    expect(() => money(-1, 'CNY')).toThrow(DomainError)
    expect(() => money(12.5, 'CNY')).toThrow(DomainError)
  })

  it('rejects unknown currency', () => {
    expect(() => money(100, 'XYZ')).toThrowError(/unsupported currency/)
  })

  it('parses decimals honoring currency exponent', () => {
    expect(parseDecimalToMinor('12.50', 'CNY')).toBe(1250)
    expect(parseDecimalToMinor('12.5', 'CNY')).toBe(1250)
    expect(parseDecimalToMinor('100', 'JPY')).toBe(100)
    expect(() => parseDecimalToMinor('100.5', 'JPY')).toThrow(DomainError)
    expect(() => parseDecimalToMinor('12.567', 'CNY')).toThrow(DomainError)
    expect(minorToDecimal(1250, 'CNY')).toBe('12.50')
    expect(isSupportedCurrency('USD')).toBe(true)
    expect(Object.keys(CURRENCIES)).toContain('CNY')
  })
})

describe('entry aggregate', () => {
  const base = {
    direction: 'expense' as const,
    amountMinor: 1250,
    currency: 'CNY',
    occurredAt: Date.now(),
    recordedAt: Date.now(),
    source: 'cli',
    recorder: 'me',
    schemaVersion: 1,
  }

  it('creates a valid entry with defaults', () => {
    const e = createEntry(base)
    expect(e.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(e.type).toBeNull()
    expect(e.revision).toBe(1)
    expect(e.voidedAt).toBeNull()
  })

  it('cannot construct an invalid entry', () => {
    expect(() => createEntry({ ...base, amountMinor: -5 })).toThrow(DomainError)
    expect(() => createEntry({ ...base, direction: 'both' as never })).toThrow(DomainError)
    expect(() => createEntry({ ...base, currency: 'XYZ' })).toThrow(DomainError)
    expect(() => createEntry({ ...base, extra: null as never })).toThrow(DomainError)
  })

  it('occurred_at may be in the future (预扣/预订)', () => {
    const e = createEntry({ ...base, occurredAt: Date.now() + 86400_000 })
    expect(e.occurredAt).toBeGreaterThan(e.recordedAt)
  })

  it('patch bumps revision and re-validates invariants', () => {
    const e = createEntry(base)
    const next = applyPatch(e, { amountMinor: 999 })
    expect(next.revision).toBe(2)
    expect(next.amountMinor).toBe(999)
    expect(() => applyPatch(e, { amountMinor: 0 })).toThrow(DomainError)
  })

  it('void keeps the row and records reason', () => {
    const e = createEntry(base)
    const v = voidEntry(e, Date.now(), '记错了')
    expect(v.voidedAt).not.toBeNull()
    expect(v.voidReason).toBe('记错了')
    expect(v.id).toBe(e.id)
  })
})

describe('ulid', () => {
  it('is monotonic within the same millisecond', () => {
    const now = Date.now()
    const a = ulid(now)
    const b = ulid(now)
    expect(b > a).toBe(true)
    expect(a.length).toBe(26)
  })
})
