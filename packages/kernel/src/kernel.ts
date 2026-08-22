import type { HostControlAPI, LedgerPlugin, PluginAdminAPI } from '@ledger/plugin-contract'
import type { EntryRepository, MetadataStore } from '@ledger/domain'
import { registerCoreCommands } from './commands.js'
import { Dispatcher } from './dispatcher.js'
import { EventBus } from './event-bus.js'
import { LedgerService } from './ledger.js'
import { createLogger } from './logger.js'
import { PluginHost } from './plugin-host.js'
import { Registry } from './registry.js'
import { ServiceRegistry } from './services.js'

export interface KernelConfig {
  coreMaintainedPlugins?: string[]
  dataDir?: string
  pluginsAdmin?: PluginAdminAPI
  hostControl?: HostControlAPI
}

export interface KernelOptions {
  repo: EntryRepository
  metaStore: MetadataStore
  config?: KernelConfig
}

export interface Kernel {
  events: EventBus
  registry: Registry
  services: ServiceRegistry
  ledger: LedgerService
  dispatcher: Dispatcher
  pluginHost: PluginHost
  loadPlugins(plugins: LedgerPlugin[]): Promise<void>
  shutdown(): Promise<void>
}

/** 组装内核：仓储/元数据存储注入（内存实现可测、SQLite 实现可产）；零插件即自洽 */
export function createKernel(opts: KernelOptions): Kernel {
  const config = opts.config ?? {}
  const log = createLogger()
  const events = new EventBus(log)
  const registry = new Registry(opts.metaStore, log)
  registry.load()
  const services = new ServiceRegistry(log)
  const ledger = new LedgerService(opts.repo, registry, events, log)
  const dispatcher = new Dispatcher(log)
  const pluginHost = new PluginHost(
    { registry, events, ledger, services, dispatcher, log },
    {
      coreMaintainedPlugins: config.coreMaintainedPlugins ?? DEFAULT_CORE_MAINTAINED,
      dataDir: config.dataDir ?? '.',
      pluginsAdmin: config.pluginsAdmin,
      hostControl: config.hostControl,
    },
  )
  registerCoreCommands({ dispatcher, ledger, registry, pluginHost, admin: config.pluginsAdmin, hostControl: config.hostControl })
  return {
    events,
    registry,
    services,
    ledger,
    dispatcher,
    pluginHost,
    loadPlugins: (plugins) => pluginHost.loadAll(plugins),
    shutdown: async () => {
      for (const info of pluginHost.list()) {
        await pluginHost.unload(info.name, 'shutdown').catch(() => {})
      }
    },
  }
}

/** AdminHostAPI 白名单默认值：核心维护插件 */
export const DEFAULT_CORE_MAINTAINED = ['plugin-cli', 'plugin-mcp']
