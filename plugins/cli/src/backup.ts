import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { openDatabase } from '@ledger/storage-sqlite'

/** 全库备份：SQLite backup API（目标文件是完整可用的数据库副本） */
export async function backupDatabase(sourcePath: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true })
  const db = openDatabase(sourcePath)
  try {
    await db.backup(destPath)
  } finally {
    db.close()
  }
}
