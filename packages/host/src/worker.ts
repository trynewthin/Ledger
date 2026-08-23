import { parentPort, workerData } from 'node:worker_threads'
import { loadPluginFromDir } from '@ledger/kernel'
import type { HostAPI, RpcResult } from '@ledger/plugin-contract'

/**
 * L2 worker 引导：在 worker 线程内加载插件，并把 HostAPI 的调用
 * 经 postMessage RPC 代理回宿主主线程。每 worker 一份全新模块注册表——
 * L2 重引导天然无模块缓存问题。
 */

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

async function main(): Promise<void> {
  const port = parentPort
  if (!port) throw new Error('worker bootstrap requires worker_threads')
  const { pluginDir, dataDir, projectRoot } = workerData as { pluginDir: string; dataDir: string; projectRoot?: string }

  const pending = new Map<number, Pending>()
  let nextCallId = 1
  const callMain = (api: string, method: string, args: unknown[]): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextCallId++
      pending.set(id, { resolve, reject })
      port.postMessage({ t: 'call', id, api, method, args })
    })

  const eventHandlers = new Map<string, Set<(payload: unknown) => void>>()
  const configHandlers = new Map<string, Set<(next: unknown, previous: unknown) => void>>()

  const plugin = await loadPluginFromDir(pluginDir)

  const proxyApi = (api: string): any =>
    new Proxy(
      {},
      {
        get: (_target, method: string) =>
          (...args: unknown[]) =>
            callMain(api, method, args),
      },
    )

  const remoteHost: HostAPI = {
    registry: proxyApi('registry'),
    events: {
      subscribe: (event: string, handler: (payload: never) => void) => {
        let set = eventHandlers.get(event)
        if (!set) {
          set = new Set()
          eventHandlers.set(event, set)
        }
        set.add(handler as (payload: unknown) => void)
        void callMain('events', '__subscribe', [event])
      },
    },
    ledger: proxyApi('ledger'),
    services: {
      // 跨线程无法传服务对象：worker 插件不参与插件间服务（plugin-user 等 L1 才提供）
      provide: () => {},
      get: () => undefined,
      onAvailable: () => {},
    },
    config: {
      get: (path) => callMain('config', 'get', [path]),
      require: (path) => callMain('config', 'require', [path]),
      snapshot: () => callMain('config', 'snapshot', []),
      status: () => callMain('config', 'status', []),
      subscribe: (path, handler) => {
        let set = configHandlers.get(path)
        const first = !set
        if (!set) {
          set = new Set()
          configHandlers.set(path, set)
        }
        set.add(handler as (next: unknown, previous: unknown) => void)
        if (first) void callMain('config', '__subscribe', [path])
      },
    },
    // 项目初始化由冷引导的 L1 插件扩展；L2 worker 不持有可序列化的初始化回调。
    initialization: {
      projectRoot: projectRoot ?? dataDir,
      register: () => { throw new Error('project initialization is not available in worker plugins') },
    },
    storage: proxyApi('storage'),
    books: proxyApi('books'),
    dispatch: ((req: Parameters<HostAPI['dispatch']>[0]) =>
      callMain('dispatch', 'invoke', [req])) as HostAPI['dispatch'],
    log: {
      debug: (m, ...a) => port.postMessage({ t: 'log', level: 'debug', msg: m, args: a }),
      info: (m, ...a) => port.postMessage({ t: 'log', level: 'info', msg: m, args: a }),
      warn: (m, ...a) => port.postMessage({ t: 'log', level: 'warn', msg: m, args: a }),
      error: (m, ...a) => port.postMessage({ t: 'log', level: 'error', msg: m, args: a }),
    },
    meta: { pluginName: plugin.manifest.name, dataDir },
  }

  port.on('message', (msg: Record<string, unknown>) => {
    const t = msg['t'] as string
    if (t === 'rpc') {
      const id = msg['id'] as number
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      if (msg['ok']) p.resolve(msg['data'])
      else p.reject(Object.assign(new Error(String((msg['error'] as any)?.message ?? 'rpc error')), { code: (msg['error'] as any)?.code }))
    } else if (t === 'event') {
      const name = msg['name'] as string
      for (const fn of eventHandlers.get(name) ?? []) {
        try {
          fn(msg['payload'])
        } catch {
          // 处理器错误不影响其他
        }
      }
    } else if (t === 'config') {
      const path = msg['path'] as string
      for (const fn of configHandlers.get(path) ?? []) {
        try {
          fn(msg['next'], msg['previous'])
        } catch {
          // 配置消费者错误不影响 worker 内其他订阅者。
        }
      }
    } else if (t === 'activate') {
      void (async () => {
        try {
          await plugin.activate(remoteHost)
          port.postMessage({ t: 'ready', manifest: plugin.manifest })
        } catch (e) {
          port.postMessage({
            t: 'activateError',
            error: { code: 'PLUGIN_ACTIVATE_FAILED', message: e instanceof Error ? e.message : String(e) },
          })
        }
      })()
    } else if (t === 'deactivate') {
      void (async () => {
        try {
          await plugin.deactivate({ reason: (msg['reason'] as 'reload' | 'shutdown' | 'crash') ?? 'shutdown' })
        } finally {
          port.postMessage({ t: 'deactivated' })
        }
      })()
    }
  })

  if ((workerData as { terminateAfterActivate?: boolean }).terminateAfterActivate) {
    // 测试钩子：激活即退出线程，模拟崩溃
    setTimeout(() => process.exit(1), 30)
  }

  port.postMessage({ t: 'bootstrapped', name: plugin.manifest.name, manifest: plugin.manifest })
}

void main()
