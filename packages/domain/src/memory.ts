import type { EntryData } from './entry.js'
import type {
  EntryFilter,
  EntryRepository,
  FieldDefRecord,
  MetadataStore,
  RevisionRecord,
  TypeDefRecord,
} from './ports.js'

/** 测试用内存仓储实现——domain/kernel 全程可纯单测 */
export class InMemoryEntryRepository implements EntryRepository {
  private rows = new Map<string, EntryData>()
  private revisions: RevisionRecord[] = []

  insert(entry: EntryData): void {
    if (this.rows.has(entry.id)) throw new Error(`duplicate entry id: ${entry.id}`)
    this.rows.set(entry.id, { ...entry, extra: { ...entry.extra } })
  }

  replace(entry: EntryData): void {
    if (!this.rows.has(entry.id)) throw new Error(`entry not found: ${entry.id}`)
    this.rows.set(entry.id, { ...entry, extra: { ...entry.extra } })
  }

  get(id: string): EntryData | undefined {
    const row = this.rows.get(id)
    return row ? { ...row, extra: { ...row.extra } } : undefined
  }

  list(filter?: EntryFilter): { items: EntryData[]; total: number } {
    let rows = [...this.rows.values()]
    if (filter) {
      if (filter.direction !== undefined) rows = rows.filter((r) => r.direction === filter.direction)
      if (filter.type !== undefined) rows = rows.filter((r) => r.type === filter.type)
      if (filter.recorder !== undefined) rows = rows.filter((r) => r.recorder === filter.recorder)
      if (filter.from !== undefined) rows = rows.filter((r) => r.occurredAt >= filter.from!)
      if (filter.to !== undefined) rows = rows.filter((r) => r.occurredAt <= filter.to!)
      if (!filter.includeVoided) rows = rows.filter((r) => r.voidedAt === null)
    }
    rows.sort((a, b) => (b.occurredAt - a.occurredAt) || (b.id < a.id ? -1 : 1))
    const total = rows.length
    const offset = filter?.offset ?? 0
    const limit = filter?.limit
    const items = rows.slice(offset, limit !== undefined ? offset + limit : undefined)
    return { items: items.map((r) => ({ ...r, extra: { ...r.extra } })), total }
  }

  insertRevision(revision: RevisionRecord): void {
    this.revisions.push({ ...revision })
  }

  listRevisions(entryId: string): RevisionRecord[] {
    return this.revisions.filter((r) => r.entryId === entryId).map((r) => ({ ...r }))
  }
}

export class InMemoryMetadataStore implements MetadataStore {
  private types = new Map<string, TypeDefRecord>()
  private fields = new Map<string, FieldDefRecord>()

  getType(key: string): TypeDefRecord | undefined {
    return this.types.get(key)
  }

  putType(def: TypeDefRecord): void {
    this.types.set(def.key, { ...def })
  }

  deleteType(key: string): void {
    this.types.delete(key)
  }

  listTypes(): TypeDefRecord[] {
    return [...this.types.values()].map((t) => ({ ...t }))
  }

  getField(key: string): FieldDefRecord | undefined {
    return this.fields.get(key)
  }

  putField(def: FieldDefRecord): void {
    this.fields.set(def.key, { ...def })
  }

  deleteField(key: string): void {
    this.fields.delete(key)
  }

  listFields(): FieldDefRecord[] {
    return [...this.fields.values()].map((f) => ({ ...f }))
  }
}
