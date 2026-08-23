import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { openDatabase } from './db.js'
import { migrate } from './migrations.js'
import { SqliteStorageService } from './storage-service.js'

/**
 * Storage Core 声明的项目资源初始化器：创建数据目录、运行核心迁移并准备
 * 插件/账本/快照/备份目录。目录固定在 dataDir 内，避免基础设施文件散落项目根。
 */
export async function initializeStorageProject(options: {
  dataDir: string
  projectRoot?: string
}): Promise<{
  dataDir: string
  databasePath: string
  appliedMigrations: number[]
  gitignoreEntry?: string
  close(): void
}> {
  const dataDir = resolve(options.dataDir)
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(join(dataDir, 'plugins'), { recursive: true }),
    mkdir(join(dataDir, 'ui-plugins'), { recursive: true }),
    mkdir(join(dataDir, 'books'), { recursive: true }),
    mkdir(join(dataDir, 'snapshots'), { recursive: true }),
    mkdir(join(dataDir, 'backups'), { recursive: true }),
  ])
  const databasePath = join(dataDir, 'ledger.db')
  const db = openDatabase(databasePath)
  const appliedMigrations = migrate(db)
  const storage = new SqliteStorageService(db, databasePath)
  const gitignoreEntry = options.projectRoot ? await ensureGitignore(options.projectRoot, dataDir) : undefined
  return { dataDir, databasePath, appliedMigrations, ...(gitignoreEntry ? { gitignoreEntry } : {}), close: () => storage.close() }
}

async function ensureGitignore(projectRoot: string, dataDir: string): Promise<string | undefined> {
  const root = resolve(projectRoot)
  const rel = relative(root, dataDir)
  if (!rel || rel.startsWith('..') || rel.includes('..' + '/') || rel.startsWith('/')) return undefined
  const entry = `${rel.replace(/\\/g, '/')}/`
  const path = join(root, '.gitignore')
  let existing = ''
  try {
    existing = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing.split(/\r?\n/).includes(entry)) return entry
  await writeFile(path, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${entry}\n`, 'utf8')
  return entry
}
