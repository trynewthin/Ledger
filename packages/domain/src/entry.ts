import { DomainError } from './errors.js'
import type { Direction } from './direction.js'
import { isDirection } from './direction.js'
import { isSupportedCurrency } from './money.js'
import { ulid } from './ulid.js'

/** 系统唯一聚合根。不变量在构造时自防护：不合法的 Entry 无法被构造，脏数据无法诞生。 */
export interface EntryData {
  id: string
  bookId: string
  direction: Direction
  /** 最小货币单位整数（分），恒正，方向由 direction 表达 */
  amountMinor: number
  currency: string
  /** 业务发生时间（epoch ms，允许未来值——预扣、预订场景） */
  occurredAt: number
  /** 入库时间（epoch ms） */
  recordedAt: number
  source: string
  recorder: string
  /** 可空：注册制类型 key */
  type: string | null
  /** 动态扩展字段载体 */
  extra: Record<string, unknown>
  /** 写入时锁定的 schema 版本，未来数据迁移的锚点 */
  schemaVersion: number
  revision: number
  /** 软删时间，null = 在册 */
  voidedAt: number | null
  voidReason: string | null
}

export interface CreateEntryInput {
  id?: string
  direction: Direction
  amountMinor: number
  currency: string
  occurredAt: number
  recordedAt: number
  source: string
  recorder: string
  type?: string | null
  extra?: Record<string, unknown>
  bookId?: string
  schemaVersion: number
}

export interface EntryPatch {
  direction?: Direction
  amountMinor?: number
  currency?: string
  type?: string | null
  occurredAt?: number
  extra?: Record<string, unknown>
  bookId?: string
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function assertEntryInvariants(e: EntryData): void {
  if (typeof e.id !== 'string' || e.id.length === 0) {
    throw new DomainError('INVALID_ENTRY', 'entry.id must be a non-empty string')
  }
  if (!isDirection(e.direction)) {
    throw new DomainError('INVALID_DIRECTION', `direction must be income|expense, got ${String(e.direction)}`)
  }
  if (!Number.isInteger(e.amountMinor) || e.amountMinor <= 0) {
    throw new DomainError('INVALID_AMOUNT', `amountMinor must be a positive integer, got ${e.amountMinor}`)
  }
  if (typeof e.currency !== 'string' || !isSupportedCurrency(e.currency)) {
    throw new DomainError('INVALID_CURRENCY', `unsupported currency: ${String(e.currency)}`)
  }
  if (!Number.isFinite(e.occurredAt) || !Number.isFinite(e.recordedAt)) {
    throw new DomainError('INVALID_ENTRY', 'occurredAt/recordedAt must be finite epoch ms')
  }
  if (typeof e.source !== 'string' || e.source.length === 0) {
    throw new DomainError('INVALID_ENTRY', 'source must be a non-empty string')
  }
  if (typeof e.recorder !== 'string' || e.recorder.length === 0) {
    throw new DomainError('INVALID_ENTRY', 'recorder must be a non-empty string')
  }
  if (e.type !== null && (typeof e.type !== 'string' || e.type.length === 0)) {
    throw new DomainError('INVALID_ENTRY', 'type must be null or a non-empty string')
  }
  if (!isPlainObject(e.extra)) {
    throw new DomainError('INVALID_ENTRY', 'extra must be a plain object')
  }
  if (typeof e.bookId !== 'string' || e.bookId.length === 0) {
    throw new DomainError('INVALID_ENTRY', 'bookId must be a non-empty string')
  }
  if (!Number.isInteger(e.schemaVersion) || e.schemaVersion < 1) {
    throw new DomainError('INVALID_ENTRY', 'schemaVersion must be a positive integer')
  }
  if (!Number.isInteger(e.revision) || e.revision < 1) {
    throw new DomainError('INVALID_ENTRY', 'revision must be a positive integer')
  }
  if (e.voidedAt !== null && !Number.isFinite(e.voidedAt)) {
    throw new DomainError('INVALID_ENTRY', 'voidedAt must be null or epoch ms')
  }
}

export function createEntry(input: CreateEntryInput): EntryData {
  const entry: EntryData = {
    id: input.id ?? ulid(),
    bookId: input.bookId ?? 'default',
    direction: input.direction,
    amountMinor: input.amountMinor,
    currency: input.currency.toUpperCase(),
    occurredAt: input.occurredAt,
    recordedAt: input.recordedAt,
    source: input.source,
    recorder: input.recorder,
    type: input.type ?? null,
    extra: input.extra === undefined ? {} : input.extra,
    schemaVersion: input.schemaVersion,
    revision: 1,
    voidedAt: null,
    voidReason: null,
  }
  assertEntryInvariants(entry)
  return entry
}

/** 修订 = 原行可改 + revision 递增，改后再过一遍不变量 */
export function applyPatch(entry: EntryData, patch: EntryPatch): EntryData {
  const next: EntryData = { ...entry, ...patch, revision: entry.revision + 1 }
  assertEntryInvariants(next)
  return next
}

export function voidEntry(entry: EntryData, voidedAt: number, reason: string): EntryData {
  return { ...entry, voidedAt, voidReason: reason }
}
