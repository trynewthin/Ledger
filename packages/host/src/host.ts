import { mkdir } from 'node:fs/promises'
import { openDatabase, migrate, SqliteEntryRepository, SqliteMetadataStore, SqliteStorageService } from '@ledger/storage-sqlite'
import { bootstrapInstalledPlugins, createKernel, DEFAULT_CORE_MAINTAINED, type ConfigProvider, type Kernel } from '@ledger/kernel'
import type { HostControlAPI, PluginAdminAPI } from '@ledger/plugin-contract'
import { createAdminFaces } from './admin.js'
import { dbPath, hostSocketPath } from './paths.js'
import { startSocketServer, type SocketServerHandle } from './socket-server.js'
import { WorkerSupervisor } from './supervisor.js'

export interface HostHandle {
  home: string
  socketPath: string
  kernel: Kernel
  supervisor: WorkerSupervisor
  plugins: PluginAdminAPI
  host: HostControlAPI
  shutdown(): Promise<void>
  closed: Promise<void>
}

/**
 * 常驻宿主：组装内核 + L1 进程内插件 + L2 worker 插件 + 本地 socket RPC。
 * CLI/MCP 冷引导用同一内核，只是组装方式不同（双形态，同一内核）。
 */
export async function startHost(opts: { home: string; withSocket?: boolean; configProvider?: ConfigProvider }): Promise<HostHandle> {
  const home = opts.home
  await mkdir(home, { recursive: true })
  const db = openDatabase(dbPath(home))
  migrate(db)
  const storage = new SqliteStorageService(db, dbPath(home))

  let kernelRef: Kernel
  let supervisorRef: WorkerSupervisor
  let socketServer: SocketServerHandle | undefined
  let shutdownResolve!: () => void

  const runtime = {
    startedAt: Date.now(),
    shutdown: async (): Promise<void> => {
      socketServer?.close().catch(() => undefined)
      await supervisorRef.shutdownAll()
      await kernelRef.shutdown()
      storage.close()
      await opts.configProvider?.close?.()
      shutdownResolve()
    },
  }

  const { plugins, host } = createAdminFaces(() => kernelRef, () => supervisorRef, home, runtime)

  const kernel = createKernel({
    repo: new SqliteEntryRepository(db),
    metaStore: new SqliteMetadataStore(db),
    config: {
      dataDir: home,
      coreMaintainedPlugins: [...DEFAULT_CORE_MAINTAINED],
      pluginsAdmin: plugins,
      hostControl: host,
      configProvider: opts.configProvider,
      storageProvider: storage,
    },
  })
  kernelRef = kernel
  // 入口共享自己的 db 连接：L1 插件（user/snapshot 等）自带表经 'db' 服务读写，内核无感知
  kernel.services.provide('db', db, 'host')

  const supervisor = new WorkerSupervisor(() => kernelRef, home, console)
  supervisorRef = supervisor

  const boot = await bootstrapInstalledPlugins(kernel, home, {
    onWorker: (name, dir) => supervisor.start(name, dir),
  })
  for (const f of boot.failed) {
    console.warn(`[host] 插件 ${f.name} 加载失败: ${f.error}`)
  }

  const closed = new Promise<void>((resolve) => {
    shutdownResolve = resolve
  })

  let sockPath = ''
  if (opts.withSocket !== false) {
    sockPath = hostSocketPath(home)
    socketServer = await startSocketServer(
      (req) => kernel.dispatcher.dispatch({ command: req.command, payload: req.payload, context: req.context }),
      sockPath,
    )
  }

  return {
    home,
    socketPath: sockPath,
    kernel,
    supervisor,
    plugins,
    host,
    shutdown: runtime.shutdown,
    closed,
  }
}

/** 宿主前台运行入口（ledger host / ledger-host bin） */
export async function runHostMain(home: string, configProvider?: ConfigProvider): Promise<number> {
  const handle = await startHost({ home, configProvider })
  console.log(`[host] ready  pid=${process.pid}  socket=${handle.socketPath}`)
  const stop = (signal: string) => {
    console.log(`[host] ${signal} received, shutting down`)
    void handle.shutdown()
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
  await handle.closed
  console.log('[host] closed')
  return 0
}
