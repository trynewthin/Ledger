import Database from 'better-sqlite3'

/** 打开（或创建）数据库：WAL 模式——多进程读写安全，CLI 与 host 并发无碍 */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  return db
}
