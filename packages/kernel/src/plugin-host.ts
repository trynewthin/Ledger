import type {
  AdminHostAPI,
  HostAPI,
  HostControlAPI,
  LedgerPlugin,
  PluginAdminAPI,
  PluginInfo,
} from '@ledger/plugin-contract'
import { AppError } from './errors.js'
import { EventBus } from './event-bus.js'
import { createPluginHostApi } from './host-api.js'
import type { HostApiDeps } from './host-api.js'
import { noopLogger } from './logger.js'
import type { Logger } from '@ledger/plugin-contract'
import { Registry } from './registry.js'
import { ServiceRegistry } from './services.js'

export interface PluginHostConfig {
  /** AdminHostAPI 白名单（内核配置，实际授权以此为准） */
  coreMaintainedPlugins?: string[]
  dataDir: string
  /** 插件管理面（install/uninstall 等文件操作由宿主注入） */
  pluginsAdmin?: PluginAdminAPI
  hostControl?: HostControlAPI
}

interface PluginRecord {
  plugin: LedgerPlugin
  state: 'active' | 'inactive' | 'crashed'
  /** L1 热替换用：模块来源路径（实例直载则为空） */
  modulePath?: string
  /** 已 deactivate 的旧实例（回滚用） */
  previous?: LedgerPlugin
}

/**
 * 插件宿主（M1：进程内 L1 + 实例生命周期；文件加载与 L1 热替换回滚见 host 包）。
 * 纪律：插件必须无状态，注册表是其唯一外部出口。
 */
export class PluginHost {
  private records = new Map<string, PluginRecord>()
  readonly deps: HostApiDeps

  constructor(
    deps: Omit<HostApiDeps, 'log'> & { log?: Logger },
    private config: PluginHostConfig,
  ) {
    this.deps = { ...deps, log: deps.log ?? noopLogger }
  }

  isAdmin(name: string): boolean {
    return (this.config.coreMaintainedPlugins ?? []).includes(name)
  }

  /** 按 provides/consumes 拓扑排序加载（consumes 一律可选，缺失自行降级，不级联失败） */
  async loadAll(plugins: LedgerPlugin[]): Promise<void> {
    for (const p of topoSort(plugins, this.deps.log)) {
      await this.load(p)
    }
  }

  async load(plugin: LedgerPlugin): Promise<void> {
    const name = plugin.manifest.name
    if (this.records.has(name)) {
      throw new AppError('PLUGIN_LOAD_FAILED', `plugin already loaded: ${name}`)
    }
    if (plugin.manifest.isolation === 'worker') {
      throw new AppError(
        'PLUGIN_LOAD_FAILED',
        `plugin ${name} declares worker isolation; it requires the resident host`,
      )
    }
    this.records.set(name, { plugin, state: 'inactive' })
    try {
      await this.activate(plugin)
    } catch (e) {
      this.records.delete(name)
      throw e
    }
  }

  private async activate(plugin: LedgerPlugin): Promise<void> {
    const name = plugin.manifest.name
    const api = createPluginHostApi(this.deps, { pluginName: name, dataDir: this.config.dataDir }, this.isAdmin(name))
    try {
      await plugin.activate(api as HostAPI | AdminHostAPI)
    } catch (e) {
      // activate 失败也要清理托管项
      this.cleanupOwner(name)
      throw new AppError(
        'PLUGIN_ACTIVATE_FAILED',
        `plugin ${name} failed to activate: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    const rec = this.records.get(name)
    if (rec) rec.state = 'active'
    this.deps.registry.markOwnerAvailable(name)
  }

  async unload(name: string, reason: 'reload' | 'shutdown' | 'crash' = 'shutdown'): Promise<void> {
    const rec = this.records.get(name)
    if (!rec) throw new AppError('PLUGIN_NOT_FOUND', `plugin not loaded: ${name}`)
    await this.deactivateRecord(rec, name, reason)
    this.records.delete(name)
  }

  private async deactivateRecord(rec: PluginRecord, name: string, reason: 'reload' | 'shutdown' | 'crash'): Promise<void> {
    try {
      await rec.plugin.deactivate({ reason })
      this.cleanupOwner(name)
    } catch (e) {
      // deactivate 抛错：托管项标记 unavailable 而非静默消失
      this.deps.registry.markOwnerUnavailable(name)
      this.deps.events.unsubscribeOwner(name)
      this.deps.services.revokeOwner(name)
      this.deps.log.warn(`plugin ${name} deactivate threw; its registrations marked unavailable`, e)
    }
  }

  /** 内核侧强制清理（不依赖插件自觉）：注册项、事件订阅、服务 */
  private cleanupOwner(name: string): void {
    this.deps.registry.unregisterByOwner(name)
    this.deps.events.unsubscribeOwner(name)
    this.deps.services.revokeOwner(name)
  }

  list(): PluginInfo[] {
    return [...this.records.values()].map((r) => ({
      name: r.plugin.manifest.name,
      version: r.plugin.manifest.version,
      isolation: r.plugin.manifest.isolation,
      state: r.state,
      provides: r.plugin.manifest.provides,
      consumes: r.plugin.manifest.consumes,
    }))
  }

  get(name: string): LedgerPlugin | undefined {
    return this.records.get(name)?.plugin
  }

  getRecord(name: string): PluginRecord | undefined {
    return this.records.get(name)
  }

  records_(): Map<string, PluginRecord> {
    return this.records
  }
}

/** 拓扑排序：provides X 的先于 consumes X；环或缺失提供者不阻塞（可选依赖） */
export function topoSort(plugins: LedgerPlugin[], log?: Logger): LedgerPlugin[] {
  const providers = new Map<string, LedgerPlugin[]>()
  for (const p of plugins) {
    for (const s of p.manifest.provides ?? []) {
      providers.set(s, [...(providers.get(s) ?? []), p])
    }
  }
  const pending = [...plugins]
  const sorted: LedgerPlugin[] = []
  const placed = new Set<string>()
  while (pending.length > 0) {
    let progressed = false
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i]!
      const consumes = p.manifest.consumes ?? []
      const satisfied = consumes.every((c) => {
        const provs = providers.get(c) ?? []
        return provs.length === 0 || provs.every((x) => placed.has(x.manifest.name))
      })
      if (satisfied) {
        sorted.push(p)
        placed.add(p.manifest.name)
        pending.splice(i, 1)
        i--
        progressed = true
      }
    }
    if (!progressed) {
      log?.warn('plugin dependency cycle detected; keeping declared order for the rest')
      sorted.push(...pending)
      break
    }
  }
  return sorted
}
