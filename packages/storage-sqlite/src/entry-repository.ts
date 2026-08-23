import Database from 'better-sqlite3'
import type { EntryData, EntryFilter, EntryRepository, RevisionRecord } from '@ledger/domain'

function rowToEntry(row: any): EntryData {
  return {
    id: row.id,
    direction: row.direction,
    amountMinor: row.amount_minor,
    currency: row.currency,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    source: row.source,
    recorder: row.recorder,
    type: row.type ?? null,
    extra: JSON.parse(row.extra ?? '{}') as Record<string, unknown>,
    schemaVersion: row.schema_version,
    revision: row.revision,
    voidedAt: row.voided_at ?? null,
    voidReason: row.void_reason ?? null,
  }
}

function entryToRow(e: EntryData) {
  return {
    id: e.id,
    direction: e.direction,
    amount_minor: e.amountMinor,
    currency: e.currency,
    occurred_at: e.occurredAt,
    recorded_at: e.recordedAt,
    source: e.source,
    recorder: e.recorder,
    type: e.type,
    extra: JSON.stringify(e.extra),
    schema_version: e.schemaVersion,
    revision: e.revision,
    voided_at: e.voidedAt,
    void_reason: e.voidReason,
  }
}

/** 仓储 SQLite 实现（实现 domain 仓储接口，依赖倒置） */
export class SqliteEntryRepository implements EntryRepository {
  private insertStmt: Database.Statement
  private replaceStmt: Database.Statement

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO entries (id, direction, amount_minor, currency, occurred_at, recorded_at,
                           source, recorder, type, extra, schema_version, revision, voided_at, void_reason)
      VALUES (@id, @direction, @amount_minor, @currency, @occurred_at, @recorded_at,
              @source, @recorder, @type, @extra, @schema_version, @revision, @voided_at, @void_reason)
    `)
    this.replaceStmt = db.prepare(`
      UPDATE entries SET direction=@direction, amount_minor=@amount_minor,
        currency=@currency, occurred_at=@occurred_at, recorded_at=@recorded_at, source=@source,
        recorder=@recorder, type=@type, extra=@extra, schema_version=@schema_version,
        revision=@revision, voided_at=@voided_at, void_reason=@void_reason
      WHERE id=@id
    `)
  }

  insert(entry: EntryData): void {
    this.insertStmt.run(entryToRow(entry))
  }

  replace(entry: EntryData): void {
    const result = this.replaceStmt.run(entryToRow(entry))
    if (result.changes === 0) throw new Error(`entry not found: ${entry.id}`)
  }

  get(id: string): EntryData | undefined {
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id)
    return row ? rowToEntry(row) : undefined
  }

  list(filter?: EntryFilter): { items: EntryData[]; total: number } {
    const where: string[] = []
    const params: Record<string, unknown> = {}
    if (filter) {
      if (filter.direction !== undefined) { where.push('direction = @direction'); params.direction = filter.direction }
      if (filter.type !== undefined) {
        if (filter.type === null) where.push('type IS NULL')
        else { where.push('type = @type'); params.type = filter.type }
      }
      if (filter.recorder !== undefined) { where.push('recorder = @recorder'); params.recorder = filter.recorder }
      if (filter.from !== undefined) { where.push('occurred_at >= @from'); params.from = filter.from }
      if (filter.to !== undefined) { where.push('occurred_at <= @to'); params.to = filter.to }
      if (!filter.includeVoided) where.push('voided_at IS NULL')
    } else {
      where.push('voided_at IS NULL')
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM entries ${whereSql}`).get(params) as { c: number }
    ).c
    let sql = `SELECT * FROM entries ${whereSql} ORDER BY occurred_at DESC, id DESC`
    if (filter?.limit !== undefined || filter?.offset !== undefined) {
      sql += ` LIMIT @limit OFFSET @offset`
      params.limit = filter?.limit ?? -1
      params.offset = filter?.offset ?? 0
    }
    const rows = this.db.prepare(sql).all(params)
    return { items: rows.map(rowToEntry), total }
  }

  insertRevision(revision: RevisionRecord): void {
    this.db
      .prepare(
        `INSERT INTO entry_revisions (id, entry_id, snapshot, actor, source, revised_at, reason)
         VALUES (@id, @entry_id, @snapshot, @actor, @source, @revised_at, @reason)`,
      )
      .run({
        id: revision.id,
        entry_id: revision.entryId,
        snapshot: revision.snapshot,
        actor: revision.actor,
        source: revision.source,
        revised_at: revision.revisedAt,
        reason: revision.reason,
      })
  }

  listRevisions(entryId: string): RevisionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM entry_revisions WHERE entry_id = ? ORDER BY revised_at ASC, id ASC')
      .all(entryId) as any[]
    return rows.map((r) => ({
      id: r.id,
      entryId: r.entry_id,
      snapshot: r.snapshot,
      actor: r.actor,
      source: r.source,
      revisedAt: r.revised_at,
      reason: r.reason ?? null,
    }))
  }
}
