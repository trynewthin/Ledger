import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AppError, type Kernel } from '@ledger/kernel'
import type { PluginInfo, RpcResult } from '@ledger/plugin-contract'
import type { Logger } from '@ledger/plugin-contract'

/** worker 引导脚本定位：dist 直邻；vitest 从 src 运行时回退到 dist */
function resolveWorkerUrl(): URL {
  const direct = new URL('./worker.js', import.meta.url)
  if (existsSync(fileURLToPath(direct))) return direct
  if (import.meta.url.includes('/src/')) {
    const alt = new URL('../dist/worker.js', import.meta.url)
    if (existsSync(fileURLToPath(alt))) return alt
  }
  return direct
}

interface WorkerRecord {
  name: string
  dir: string
  version: string
  worker: Worker
  state: 'starting' | 'active' | 'stopping' | 'crashed'
  restarts: number
  lastStartAt: number
  intentionalStop: boolean
}

const MAX_RESTARTS = 5
const STABLE_MS = 60_000
const CTX_LEDGER_METHODS = new Set(['addEntry', 'reviseEntry', 'voidEntry'])

/**
 * L2 supervisor：worker 线程托管、崩溃退避重启、优雅停机。
 * 宿主与其他插件全程存活——worker 崩溃只影响该插件。
 */
export class WorkerSupervisor {
  private records = new Map<string, WorkerRecord>()

  constructor(
    private getKernel: () => Kernel,
    private dataDir: string,
    private log: Logger = console,
  ) {}

  states(): PluginInfo[] {
    return [...this.records.values()].map((r) => ({
      name: r.name,
      version: r.version,
      isolation: 'worker' as const,
      state: r.state === 'active' ? ('active' as const) : r.state === 'crashed' ? ('crashed' as const) : ('inactive' as const),
    }))
  }

  get(name: string): WorkerRecord | undefined {
    return this.records.get(name)
  }

  async start(name: string, dir: string, opts?: { terminateAfterActivate?: boolean }): Promise<void> {
    if (this.records.has(name)) throw new AppError('PLUGIN_LOAD_FAILED', `worker plugin already running: ${name}`)
    await this.spawn(name, dir, 0, opts)
  }

  private async spawn(name: string, dir: string, restarts: number, opts?: { terminateAfterActivate?: boolean }): Promise<void> {
    const workerUrl = resolveWorkerUrl()
    const worker = new Worker(workerUrl, {
      workerData: { pluginDir: dir, dataDir: this.dataDir, terminateAfterActivate: opts?.terminateAfterActivate ?? false },
    })
    const rec: WorkerRecord = {
      name,
      dir,
      version: '?',
      worker,
      state: 'starting',
      restarts,
      lastStartAt: Date.now(),
      intentionalStop: false,
    }
    this.records.set(name, rec)

    let onReady: () => void = () => {}
    let onReadyFailed: (e: unknown) => void = () => {}
    const ready = new Promise<void>((resolve, reject) => {
      onReady = resolve
      onReadyFailed = reject
    })
    let onDeactivated: () => void = () => {}
    const deactivated = new Promise<void>((resolve) => {
      onDeactivated = resolve
    })

    worker.on('message', (msg: Record<string, unknown>) => {
      const t = msg['t'] as string
      if (t === 'bootstrapped') {
        worker.postMessage({ t: 'activate' })
      } else if (t === 'ready') {
        rec.version = (msg['manifest'] as { version?: string })?.version ?? '?'
        rec.state = 'active'
        onReady()
      } else if (t === 'activateError') {
        rec.intentionalStop = true
        void worker.terminate()
        this.records.delete(name)
        onReadyFailed(new AppError('PLUGIN_ACTIVATE_FAILED', `${name}: ${(msg['error'] as { message?: string })?.message ?? 'activate failed'}`))
      } else if (t === 'log') {
        const level = msg['level'] as keyof Logger
        this.log[level]?.(`[${name}]`, String(msg['msg']), ...((msg['args'] as unknown[]) ?? []))
      } else if (t === 'deactivated') {
        onDeactivated()
      } else if (t === 'call') {
        void this.handleCall(rec, msg)
          .then((result) => worker.postMessage({ t: 'rpc', id: msg['id'], ok: true, data: result }))
          .catch((e: unknown) =>
            worker.postMessage({
              t: 'rpc',
              id: msg['id'],
              ok: false,
              error: {
                code: (e as { code?: string }).code ?? 'INTERNAL',
                message: e instanceof Error ? e.message : String(e),
              },
            }),
          )
      }
    })

    worker.on('error', (e) => {
      this.log.error(`[${name}] worker error`, e)
    })

    worker.on('exit', (code) => {
      if (rec.intentionalStop) {
        this.records.delete(name)
        return
      }
      // 崩溃：退避重启；稳定运行一段时间后重置计数
      const stableFor = Date.now() - rec.lastStartAt
      const newRestarts = stableFor > STABLE_MS ? 1 : rec.restarts + 1
      if (newRestarts > MAX_RESTARTS) {
        rec.state = 'crashed'
        this.records.delete(name)
        this.log.error(`[${name}] worker exited (code ${code}) — giving up after ${MAX_RESTARTS} restarts`)
        return
      }
      const delay = Math.min(500 * 2 ** (newRestarts - 1), 8_000)
      this.log.warn(`[${name}] worker exited (code ${code}); restarting in ${delay}ms (attempt ${newRestarts}/${MAX_RESTARTS})`)
      this.records.delete(name)
      setTimeout(() => {
        this.start(name, dir, { terminateAfterActivate: opts?.terminateAfterActivate }).catch((e: unknown) => {
          this.log.error(`[${name}] restart failed`, e)
        })
      }, delay)
    })

    const timeout = setTimeout(() => {
      if (rec.state !== 'active') {
        rec.intentionalStop = true
        void worker.terminate()
        this.records.delete(name)
        onReadyFailed(new AppError('PLUGIN_ACTIVATE_FAILED', `${name}: worker activation timed out`))
      }
    }, 15_000)
    try {
      await ready
    } finally {
      clearTimeout(timeout)
    }
  }

  private async handleCall(rec: WorkerRecord, msg: Record<string, unknown>): Promise<unknown> {
    const kernel = this.getKernel()
    const api = msg['api'] as string
    const method = msg['method'] as string
    const args = (msg['args'] as unknown[]) ?? []
    switch (api) {
      case 'dispatch': {
        const req = (args[0] ?? {}) as { command: string; payload?: unknown; context?: { source?: string; recorder?: string } }
        const result = await kernel.dispatcher.dispatch({
          command: req.command,
          payload: req.payload,
          context: { source: req.context?.source ?? `plugin:${rec.name}`, recorder: req.context?.recorder ?? 'me' },
        })
        return result as RpcResult
      }
      case 'ledger': {
        const fn = (kernel.ledger as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
        if (typeof fn !== 'function') throw new AppError('NOT_SUPPORTED', `ledger.${method} is not available over worker bridge`)
        const callArgs = CTX_LEDGER_METHODS.has(method)
          ? [args[0], (args[1] as object | undefined) ?? { source: `plugin:${rec.name}`, recorder: 'me' }]
          : args
        return fn.apply(kernel.ledger, callArgs)
      }
      case 'registry': {
        if (method === 'registerType') return kernel.registry.registerType(args[0] as never, { origin: 'plugin', owner: rec.name })
        if (method === 'registerField') return kernel.registry.registerField(args[0] as never, { origin: 'plugin', owner: rec.name })
        if (method === 'getType') return kernel.registry.listTypes({ includeUnavailable: true }).find((t) => t.key === args[0])
        if (method === 'listTypes') return kernel.registry.listTypes(args[0] as never)
        if (method === 'getField') return kernel.registry.listFields({ includeUnavailable: true }).find((f) => f.key === args[0])
        if (method === 'listFields') return kernel.registry.listFields(args[0] as never)
        throw new AppError('NOT_SUPPORTED', `registry.${method} is not available over worker bridge`)
      }
      case 'events': {
        if (method === '__subscribe') {
          const eventName = String(args[0])
          kernel.events.subscribe(
            eventName,
            (payload) => {
              try {
                rec.worker.postMessage({ t: 'event', name: eventName, payload })
              } catch {
                // worker 已死则丢弃
              }
            },
            rec.name,
          )
          return undefined
        }
        throw new AppError('NOT_SUPPORTED', `events.${method} is not available over worker bridge`)
      }
      case 'log': {
        const level = method as keyof Logger
        this.log[level]?.(`[${rec.name}]`, String(args[0]), ...(args.slice(1) as unknown[]))
        return undefined
      }
      case 'meta':
        return { pluginName: rec.name, dataDir: this.dataDir }
      default:
        throw new AppError('NOT_SUPPORTED', `api "${api}" is not available over worker bridge`)
    }
  }

  /** drain → kill：优雅停机（等待 deactivate，超时强杀） */
  async stop(name: string, reason: 'reload' | 'shutdown' = 'shutdown'): Promise<void> {
    const rec = this.records.get(name)
    if (!rec) throw new AppError('PLUGIN_NOT_FOUND', `worker plugin not running: ${name}`)
    rec.intentionalStop = true
    rec.state = 'stopping'
    rec.worker.postMessage({ t: 'deactivate', reason })
    await Promise.race([
      new Promise<void>((resolve) => {
        rec.worker.once('message', (msg: Record<string, unknown>) => {
          if (msg['t'] === 'deactivated') resolve()
        })
        setTimeout(resolve, 3_000)
      }),
    ])
    await rec.worker.terminate()
    this.records.delete(name)
  }

  /** L2 重引导 = 重启 worker（fresh 模块注册表） */
  async reload(name: string): Promise<PluginInfo> {
    const rec = this.records.get(name)
    if (!rec) throw new AppError('PLUGIN_NOT_FOUND', `worker plugin not running: ${name}`)
    const { dir } = rec
    await this.stop(name, 'reload')
    await this.start(name, dir)
    return this.states().find((s) => s.name === name)!
  }

  /** 强杀（崩溃模拟 / 管理强制操作） */
  forceKill(name: string): void {
    const rec = this.records.get(name)
    if (!rec) throw new AppError('PLUGIN_NOT_FOUND', `worker plugin not running: ${name}`)
    void rec.worker.terminate()
  }

  async shutdownAll(): Promise<void> {
    for (const rec of [...this.records.values()]) {
      await this.stop(rec.name, 'shutdown').catch(() => undefined)
    }
  }
}
