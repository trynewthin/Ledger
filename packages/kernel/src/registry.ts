import type { Direction, FieldEnumValue, TypeDefDTO, FieldDefDTO } from '@ledger/plugin-contract'
import type { FieldDefRecord, MetadataStore, TypeDefRecord } from '@ledger/domain'
import type { Logger } from '@ledger/plugin-contract'
import { AppError } from './errors.js'

export type RegistrationOrigin = { origin: 'plugin' | 'user'; owner: string }

export interface TypeRegistrationInput {
  key: string
  label: string
  direction: Direction
  parentKey?: string | null
  icon?: string | null
  schema?: string | null
  overwrite?: boolean
}

export interface FieldRegistrationInput {
  key: string
  label: string
  scope: 'expense' | 'income' | 'both'
  valueType: 'string' | 'number' | 'enum' | 'date' | 'boolean'
  enumValues?: FieldEnumValue[]
  overwrite?: boolean
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(key)) {
    throw new AppError('VALIDATION_ERROR', `invalid key "${key}": must be lowercase slug (a-z, 0-9, -, _), max 64 chars`)
  }
}

/**
 * 统一注册表：entry.type / entry.field（将来 adapter、report 等只是新增种类）。
 * 三来源（插件 activate、用户运行时、manifest 贡献）共用同一张表；
 * 插件起源的项随 deactivate 自动反注册，提供者异常时标记 unavailable 而非静默消失。
 */
export class Registry {
  private types = new Map<string, TypeDefRecord>()
  private fields = new Map<string, FieldDefRecord>()
  private unavailableOwners = new Set<string>()

  constructor(
    private store: MetadataStore,
    private log: Logger = { debug() {}, info() {}, warn() {}, error() {} },
  ) {}

  load(): void {
    this.types.clear()
    this.fields.clear()
    for (const t of this.store.listTypes()) this.types.set(t.key, t)
    for (const f of this.store.listFields()) this.fields.set(f.key, f)
  }

  registerType(input: TypeRegistrationInput, from: RegistrationOrigin): TypeDefRecord {
    validateKey(input.key)
    const existing = this.types.get(input.key)
    if (existing && !(input.overwrite && existing.owner === from.owner)) {
      throw new AppError('TYPE_KEY_TAKEN', `type "${input.key}" already registered by ${existing.owner}`)
    }
    if (input.parentKey != null && input.parentKey === input.key) {
      throw new AppError('VALIDATION_ERROR', `type "${input.key}" cannot be its own parent`)
    }
    const def: TypeDefRecord = {
      key: input.key,
      label: input.label,
      direction: input.direction,
      parentKey: input.parentKey ?? null,
      icon: input.icon ?? null,
      schema: input.schema ?? null,
      origin: from.origin,
      owner: from.owner,
      enabled: true,
      registeredAt: existing?.registeredAt ?? Date.now(),
    }
    this.types.set(def.key, def)
    this.store.putType(def)
    this.unavailableOwners.delete(from.owner)
    return { ...def }
  }

  registerField(input: FieldRegistrationInput, from: RegistrationOrigin): FieldDefRecord {
    validateKey(input.key)
    const existing = this.fields.get(input.key)
    if (existing && !(input.overwrite && existing.owner === from.owner)) {
      throw new AppError('FIELD_KEY_TAKEN', `field "${input.key}" already registered by ${existing.owner}`)
    }
    if (input.valueType === 'enum') {
      if (!input.enumValues || input.enumValues.length === 0) {
        throw new AppError('VALIDATION_ERROR', `enum field "${input.key}" requires non-empty enumValues`)
      }
    }
    const def: FieldDefRecord = {
      key: input.key,
      label: input.label,
      scope: input.scope,
      valueType: input.valueType,
      enumValues: input.enumValues?.map((v) => ({ ...v })) ?? null,
      origin: from.origin,
      owner: from.owner,
      enabled: true,
      registeredAt: existing?.registeredAt ?? Date.now(),
    }
    this.fields.set(def.key, def)
    this.store.putField(def)
    this.unavailableOwners.delete(from.owner)
    return { ...def }
  }

  unregisterByOwner(owner: string): void {
    for (const t of [...this.types.values()]) {
      if (t.owner === owner && t.origin === 'plugin') {
        this.types.delete(t.key)
        this.store.deleteType(t.key)
      }
    }
    for (const f of [...this.fields.values()]) {
      if (f.owner === owner && f.origin === 'plugin') {
        this.fields.delete(f.key)
        this.store.deleteField(f.key)
      }
    }
  }

  /** 提供者崩溃/停用未完成清理时：标记其名下项不可用（保留而非删除，历史可追溯） */
  markOwnerUnavailable(owner: string): void {
    this.unavailableOwners.add(owner)
  }

  markOwnerAvailable(owner: string): void {
    this.unavailableOwners.delete(owner)
  }

  isOwnerUnavailable(owner: string): boolean {
    return this.unavailableOwners.has(owner)
  }

  getType(key: string): TypeDefRecord | undefined {
    return this.types.get(key)
  }

  listTypes(filter?: { direction?: Direction; includeUnavailable?: boolean }): TypeDefDTO[] {
    let items = [...this.types.values()]
    if (filter?.direction) items = items.filter((t) => t.direction === filter.direction)
    return items.map((t) => this.decorateType(t, filter?.includeUnavailable))
  }

  listTypesRaw(): TypeDefRecord[] {
    return [...this.types.values()].map((t) => ({ ...t }))
  }

  private decorateType(t: TypeDefRecord, includeUnavailable = false): TypeDefDTO {
    const unavailable = this.unavailableOwners.has(t.owner)
    if (unavailable && !includeUnavailable) return { ...t, enabled: false, unavailable: true }
    return { ...t, unavailable }
  }

  getField(key: string): FieldDefRecord | undefined {
    return this.fields.get(key)
  }

  listFields(filter?: { scope?: 'expense' | 'income' | 'both'; includeUnavailable?: boolean }): FieldDefDTO[] {
    let items = [...this.fields.values()]
    if (filter?.scope) items = items.filter((f) => f.scope === filter.scope || f.scope === 'both')
    return items.map((f) => this.decorateField(f, filter?.includeUnavailable))
  }

  listFieldsRaw(): FieldDefRecord[] {
    return [...this.fields.values()].map((f) => ({ ...f }))
  }

  private decorateField(f: FieldDefRecord, includeUnavailable = false): FieldDefDTO {
    const unavailable = this.unavailableOwners.has(f.owner)
    if (unavailable && !includeUnavailable) return { ...f, enabled: false, unavailable: true }
    return { ...f, unavailable }
  }

  /** 供校验使用的有效定义（enabled 且提供者可用） */
  effectiveType(key: string): TypeDefRecord | undefined {
    const t = this.types.get(key)
    if (!t || !t.enabled) return undefined
    if (this.unavailableOwners.has(t.owner)) return undefined
    return t
  }

  effectiveFields(): FieldDefRecord[] {
    return [...this.fields.values()].filter(
      (f) => f.enabled && !this.unavailableOwners.has(f.owner),
    )
  }
}
