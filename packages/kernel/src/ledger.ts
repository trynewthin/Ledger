import type {
  EntryData,
  EntryFilter,
  EntryRepository,
} from '@ledger/domain'
import {
  applyPatch,
  createEntry,
  voidEntry as voidEntryDomain,
  ulid,
} from '@ledger/domain'
import type {
  CallContext,
  CurrencyTotal,
  CurrencyTotals,
  EntryDTO,
  StatsByDirectionItem,
  StatsByTypeItem,
  StatsKind,
  StatsMonthlyItem,
  StatsSummary,
} from '@ledger/plugin-contract'
import type { Logger } from '@ledger/plugin-contract'
import { AppError } from './errors.js'
import { EventBus } from './event-bus.js'
import { Registry } from './registry.js'
import { addEntrySchema, listEntriesSchema, parseOrThrow, reviseEntrySchema, validateExtraAgainstFields, voidEntrySchema } from './validation.js'

export const CURRENT_SCHEMA_VERSION = 1

/**
 * 应用层：编排校验（type 是否注册、direction 是否匹配、extra 字段定义校验），
 * 领域层不变量是最终防线（聚合构造即校验）。统计只依赖 direction，永不查插件表。
 */
export class LedgerService {
  constructor(
    private repo: EntryRepository,
    private registry: Registry,
    private events: EventBus,
    private log: Logger = { debug() {}, info() {}, warn() {}, error() {} },
  ) {}

  addEntry(input: unknown, ctx: CallContext): EntryDTO {
    const parsed = parseOrThrow(addEntrySchema, input, 'entry.add')
    const type = parsed.type ?? null
    if (type !== null) {
      const def = this.registry.effectiveType(type)
      if (!def) {
        throw new AppError('TYPE_NOT_REGISTERED', `type "${type}" is not registered (or its provider is unavailable)`)
      }
      if (def.direction !== parsed.direction) {
        throw new AppError(
          'TYPE_DIRECTION_MISMATCH',
          `type "${type}" is ${def.direction}, cannot be used on a ${parsed.direction} entry`,
        )
      }
    }
    const extra = parsed.extra ?? {}
    validateExtraAgainstFields(extra, this.registry.effectiveFields(), {
      direction: parsed.direction,
      strictExtra: parsed.strictExtra ?? false,
    })
    const entry = createEntry({
      direction: parsed.direction,
      amountMinor: parsed.amountMinor,
      currency: parsed.currency,
      occurredAt: parsed.occurredAt ?? Date.now(),
      recordedAt: Date.now(),
      source: ctx.source,
      recorder: ctx.recorder,
      type,
      extra,
      bookId: parsed.bookId,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    })
    this.repo.insert(entry)
    this.events.emit('EntryRecorded', { kind: 'EntryRecorded', entry, context: ctx })
    return entry
  }

  reviseEntry(input: unknown, ctx: CallContext): EntryDTO {
    const parsed = parseOrThrow(reviseEntrySchema, input, 'entry.revise')
    const current = this.requireEntry(parsed.id)
    if (current.voidedAt !== null) {
      throw new AppError('ENTRY_VOIDED', `entry ${parsed.id} is voided and cannot be revised`)
    }
    const patch = parsed.patch ?? {}
    const direction = patch.direction ?? current.direction
    const type = patch.type !== undefined ? patch.type : current.type
    if (type !== null) {
      const def = this.registry.effectiveType(type)
      if (!def) {
        throw new AppError('TYPE_NOT_REGISTERED', `type "${type}" is not registered (or its provider is unavailable)`)
      }
      if (def.direction !== direction) {
        throw new AppError(
          'TYPE_DIRECTION_MISMATCH',
          `type "${type}" is ${def.direction}, cannot be used on a ${direction} entry`,
        )
      }
    }
    const extra = patch.extra ?? current.extra
    validateExtraAgainstFields(extra, this.registry.effectiveFields(), {
      direction,
      strictExtra: parsed.strictExtra ?? false,
    })
    const next = applyPatch(current, patch)
    this.repo.insertRevision({
      id: ulid(),
      entryId: current.id,
      snapshot: JSON.stringify(current),
      actor: ctx.recorder,
      source: ctx.source,
      revisedAt: Date.now(),
      reason: parsed.reason ?? null,
    })
    this.repo.replace(next)
    this.events.emit('EntryRevised', { kind: 'EntryRevised', entry: next, before: current, context: ctx })
    return next
  }

  voidEntry(input: unknown, ctx: CallContext): EntryDTO {
    const parsed = parseOrThrow(voidEntrySchema, input, 'entry.void')
    const current = this.requireEntry(parsed.id)
    if (current.voidedAt !== null) {
      throw new AppError('ENTRY_VOIDED', `entry ${parsed.id} is already voided`)
    }
    const next = voidEntryDomain(current, Date.now(), parsed.reason)
    this.repo.replace(next)
    this.events.emit('EntryVoided', { kind: 'EntryVoided', entry: next, context: ctx })
    return next
  }

  getEntry(id: string): EntryDTO {
    return this.requireEntry(id)
  }

  listEntries(filterInput?: unknown): { items: EntryDTO[]; total: number } {
    const filter = filterInput ? parseOrThrow(listEntriesSchema, filterInput, 'entry.list') : undefined
    return this.repo.list(filter)
  }

  listRevisions(entryId: string) {
    this.requireEntry(entryId)
    return this.repo.listRevisions(entryId)
  }

  stats(kind: StatsKind, filterInput?: unknown): StatsSummary | StatsMonthlyItem[] | StatsByTypeItem[] | StatsByDirectionItem[] {
    const filter = filterInput ? parseOrThrow(listEntriesSchema, filterInput, `stats.${kind}`) : undefined
    const items = this.repo.list({ ...filter, includeVoided: filter?.includeVoided ?? false }).items
    switch (kind) {
      case 'summary':
        return summarize(items)
      case 'monthly':
        return monthly(items)
      case 'byType':
        return byType(items)
      case 'byDirection':
        return byDirection(items)
      default:
        throw new AppError('VALIDATION_ERROR', `unknown stats kind: ${String(kind)}`)
    }
  }

  private requireEntry(id: string): EntryData {
    const entry = this.repo.get(id)
    if (!entry) throw new AppError('ENTRY_NOT_FOUND', `entry ${id} not found`)
    return entry
  }
}

function emptyTotals(): CurrencyTotals {
  return {}
}

function addTotal(totals: CurrencyTotals, currency: string, amountMinor: number): void {
  const cur: CurrencyTotal = totals[currency] ?? { count: 0, totalMinor: 0 }
  cur.count += 1
  cur.totalMinor += amountMinor
  totals[currency] = cur
}

function summarize(items: EntryData[]): StatsSummary {
  const income = emptyTotals()
  const expense = emptyTotals()
  for (const e of items) addTotal(e.direction === 'income' ? income : expense, e.currency, e.amountMinor)
  const net: Record<string, number> = {}
  for (const [c, t] of Object.entries(income)) net[c] = (net[c] ?? 0) + t.totalMinor
  for (const [c, t] of Object.entries(expense)) net[c] = (net[c] ?? 0) - t.totalMinor
  return { income, expense, net }
}

/** 统计按本地时区聚合（存储统一 UTC epoch ms） */
function localMonth(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthly(items: EntryData[]): StatsMonthlyItem[] {
  const map = new Map<string, StatsMonthlyItem>()
  for (const e of items) {
    const month = localMonth(e.occurredAt)
    let item = map.get(month)
    if (!item) {
      item = { month, income: emptyTotals(), expense: emptyTotals() }
      map.set(month, item)
    }
    addTotal(e.direction === 'income' ? item.income : item.expense, e.currency, e.amountMinor)
  }
  return [...map.values()].sort((a, b) => (a.month < b.month ? -1 : 1))
}

function sumTotals(totals: CurrencyTotals): number {
  return Object.values(totals).reduce((acc, t) => acc + t.totalMinor, 0)
}

function byType(items: EntryData[]): StatsByTypeItem[] {
  const map = new Map<string, StatsByTypeItem>()
  for (const e of items) {
    const key = e.type ?? ''
    let item = map.get(key)
    if (!item) {
      item = { type: e.type, direction: e.direction, totals: emptyTotals() }
      map.set(key, item)
    }
    addTotal(item.totals, e.currency, e.amountMinor)
  }
  return [...map.values()].sort((a, b) => sumTotals(b.totals) - sumTotals(a.totals))
}

function byDirection(items: EntryData[]): StatsByDirectionItem[] {
  const map = new Map<string, StatsByDirectionItem>()
  for (const e of items) {
    let item = map.get(e.direction)
    if (!item) {
      item = { direction: e.direction, totals: emptyTotals() }
      map.set(e.direction, item)
    }
    addTotal(item.totals, e.currency, e.amountMinor)
  }
  return [...map.values()]
}
