import type { Direction } from './direction.js'

/** 修订前像快照（谁、从哪入口、何时、为什么改） */
export interface RevisionRecord {
  id: string
  entryId: string
  /** 修改前完整 JSON */
  snapshot: string
  actor: string
  source: string
  revisedAt: number
  reason: string | null
}

export interface EntryFilter {
  direction?: Direction
  /** null = 显式过滤无类型条目；undefined = 不过滤 */
  type?: string | null
  recorder?: string
  /** occurredAt 范围（epoch ms） */
  from?: number
  to?: number
  includeVoided?: boolean
  limit?: number
  offset?: number
}

/** 仓储接口在 domain（纯接口，零 IO）；SQLite 实现在 storage-sqlite（依赖倒置） */
export interface EntryRepository {
  insert(entry: import('./entry.js').EntryData): void
  /** 修订语义：原行可改 */
  replace(entry: import('./entry.js').EntryData): void
  get(id: string): import('./entry.js').EntryData | undefined
  list(filter?: EntryFilter): { items: import('./entry.js').EntryData[]; total: number }
  insertRevision(revision: RevisionRecord): void
  listRevisions(entryId: string): RevisionRecord[]
}

export interface TypeDefRecord {
  key: string
  label: string
  direction: Direction
  parentKey: string | null
  icon: string | null
  schema: string | null
  origin: 'plugin' | 'user'
  owner: string
  enabled: boolean
  registeredAt: number
}

export interface FieldEnumValue {
  value: string
  label: string
  icon?: string
}

export interface FieldDefRecord {
  key: string
  label: string
  scope: 'expense' | 'income' | 'both'
  valueType: 'string' | 'number' | 'enum' | 'date' | 'boolean'
  enumValues: FieldEnumValue[] | null
  origin: 'plugin' | 'user'
  owner: string
  enabled: boolean
  registeredAt: number
}

/** 统一注册表的持久化端口（type_defs / field_defs；将来新扩展点只是新增种类） */
export interface MetadataStore {
  getType(key: string): TypeDefRecord | undefined
  putType(def: TypeDefRecord): void
  deleteType(key: string): void
  listTypes(): TypeDefRecord[]
  getField(key: string): FieldDefRecord | undefined
  putField(def: FieldDefRecord): void
  deleteField(key: string): void
  listFields(): FieldDefRecord[]
}
