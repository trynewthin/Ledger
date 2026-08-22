import { mkdir } from 'node:fs/promises'
import { openDatabase, migrate, SqliteEntryRepository, SqliteMetadataStore } from '@ledger/storage-sqlite'
import { bootstrapInstalledPlugins, createKernel, DEFAULT_CORE_MAINTAINED, type Kernel } from '@ledger/kernel'
import { dbPath } from './paths.js'

type Db = ReturnType<typeof openDatabase>

export interface ColdBoot {
  kernel: Kernel
  db: Db
  close(): void
}

/**
 * 冷引导：本地组装内核 + 已安装 L1 插件（与 host 同一内核，组装方式不同）。
 * CLI / MCP 共用此形态：加载 → 执行 → 退出。
 */
export async function assembleColdKernel(home: string): Promise<ColdBoot> {
  await mkdir(home, { recursive: true })
  const db = openDatabase(dbPath(home))
  migrate(db)
  const kernel = createKernel({
    repo: new SqliteEntryRepository(db),
    metaStore: new SqliteMetadataStore(db),
    config: { dataDir: home, coreMaintainedPlugins: [...DEFAULT_CORE_MAINTAINED] },
  })
  // 入口共享自己的 db 连接：L1 插件（user/snapshot 等）自带表经 'db' 服务读写，内核无感知
  kernel.services.provide('db', db, 'entry')
  const boot = await bootstrapInstalledPlugins(kernel, home)
  if (boot.skippedWorker.length > 0) {
    console.error(`提示: worker 隔离插件需常驻宿主运行，已跳过: ${boot.skippedWorker.join(', ')}`)
  }
  return {
    kernel,
    db,
    close: () => db.close(),
  }
}
