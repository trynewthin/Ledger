import Database from 'better-sqlite3'
import type { FieldDefRecord, MetadataStore, TypeDefRecord } from '@ledger/domain'

/** type_defs / field_defs 注册表持久化（SQLite 实现） */
export class SqliteMetadataStore implements MetadataStore {
  constructor(private db: Database.Database) {}

  getType(key: string): TypeDefRecord | undefined {
    const row = this.db.prepare('SELECT * FROM type_defs WHERE key = ?').get(key) as any
    return row ? rowToType(row) : undefined
  }

  putType(def: TypeDefRecord): void {
    this.db
      .prepare(
        `INSERT INTO type_defs (key, label, direction, parent_key, icon, origin, owner, schema, enabled, registered_at)
         VALUES (@key, @label, @direction, @parent_key, @icon, @origin, @owner, @schema, @enabled, @registered_at)
         ON CONFLICT(key) DO UPDATE SET label=@label, direction=@direction, parent_key=@parent_key,
           icon=@icon, schema=@schema, enabled=@enabled`,
      )
      .run({
        key: def.key,
        label: def.label,
        direction: def.direction,
        parent_key: def.parentKey,
        icon: def.icon,
        origin: def.origin,
        owner: def.owner,
        schema: def.schema,
        enabled: def.enabled ? 1 : 0,
        registered_at: def.registeredAt,
      })
  }

  deleteType(key: string): void {
    this.db.prepare('DELETE FROM type_defs WHERE key = ?').run(key)
  }

  listTypes(): TypeDefRecord[] {
    const rows = this.db.prepare('SELECT * FROM type_defs ORDER BY registered_at, key').all() as any[]
    return rows.map(rowToType)
  }

  getField(key: string): FieldDefRecord | undefined {
    const row = this.db.prepare('SELECT * FROM field_defs WHERE key = ?').get(key) as any
    return row ? rowToField(row) : undefined
  }

  putField(def: FieldDefRecord): void {
    this.db
      .prepare(
        `INSERT INTO field_defs (key, label, scope, value_type, enum_values, origin, owner, enabled, registered_at)
         VALUES (@key, @label, @scope, @value_type, @enum_values, @origin, @owner, @enabled, @registered_at)
         ON CONFLICT(key) DO UPDATE SET label=@label, scope=@scope, value_type=@value_type,
           enum_values=@enum_values, enabled=@enabled`,
      )
      .run({
        key: def.key,
        label: def.label,
        scope: def.scope,
        value_type: def.valueType,
        enum_values: def.enumValues ? JSON.stringify(def.enumValues) : null,
        origin: def.origin,
        owner: def.owner,
        enabled: def.enabled ? 1 : 0,
        registered_at: def.registeredAt,
      })
  }

  deleteField(key: string): void {
    this.db.prepare('DELETE FROM field_defs WHERE key = ?').run(key)
  }

  listFields(): FieldDefRecord[] {
    const rows = this.db.prepare('SELECT * FROM field_defs ORDER BY registered_at, key').all() as any[]
    return rows.map(rowToField)
  }
}

function rowToType(r: any): TypeDefRecord {
  return {
    key: r.key,
    label: r.label,
    direction: r.direction,
    parentKey: r.parent_key ?? null,
    icon: r.icon ?? null,
    schema: r.schema ?? null,
    origin: r.origin,
    owner: r.owner,
    enabled: r.enabled === 1,
    registeredAt: r.registered_at,
  }
}

function rowToField(r: any): FieldDefRecord {
  return {
    key: r.key,
    label: r.label,
    scope: r.scope,
    valueType: r.value_type,
    enumValues: r.enum_values ? (JSON.parse(r.enum_values) as FieldDefRecord['enumValues']) : null,
    origin: r.origin,
    owner: r.owner,
    enabled: r.enabled === 1,
    registeredAt: r.registered_at,
  }
}
