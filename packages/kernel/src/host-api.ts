import type {
  AdminHostAPI,
  CallContext,
  HostAPI,
  HostControlAPI,
  PluginAdminAPI,
} from '@ledger/plugin-contract'
import { EventBus } from './event-bus.js'
import { LedgerService } from './ledger.js'
import { Registry } from './registry.js'
import { ServiceRegistry } from './services.js'
import type { Logger } from '@ledger/plugin-contract'

export interface HostApiDeps {
  registry: Registry
  events: EventBus
  ledger: LedgerService
  services: ServiceRegistry
  log: Logger
  pluginsAdmin?: PluginAdminAPI
  hostControl?: HostControlAPI
}

export interface HostApiContext {
  pluginName: string
  dataDir: string
}

function ctxFor(name: string, ctx?: Partial<CallContext>): CallContext {
  return { source: ctx?.source ?? `plugin:${name}`, recorder: ctx?.recorder ?? 'me' }
}

/**
 * 能力面构造：所有插件获得 HostAPI；内核白名单（coreMaintainedPlugins）内获得 AdminHostAPI。
 * 托管项（注册表项/事件订阅/服务）按插件名打标，随 deactivate 自动反注册。
 */
export function createPluginHostApi(deps: HostApiDeps, ctx: HostApiContext, isAdmin: boolean): HostAPI | AdminHostAPI {
  const { registry, events, ledger, services } = deps
  const log: Logger = {
    debug: (m, ...a) => deps.log.debug(`[${ctx.pluginName}] ${m}`, ...a),
    info: (m, ...a) => deps.log.info(`[${ctx.pluginName}] ${m}`, ...a),
    warn: (m, ...a) => deps.log.warn(`[${ctx.pluginName}] ${m}`, ...a),
    error: (m, ...a) => deps.log.error(`[${ctx.pluginName}] ${m}`, ...a),
  }

  const base: HostAPI = {
    registry: {
      registerType: async (def) => {
        registry.registerType(def, { origin: 'plugin', owner: ctx.pluginName })
      },
      registerField: async (def) => {
        registry.registerField(def, { origin: 'plugin', owner: ctx.pluginName })
      },
      getType: async (key) => registry.listTypes({ includeUnavailable: true }).find((t) => t.key === key),
      listTypes: async (filter) => registry.listTypes(filter),
      getField: async (key) => registry.listFields({ includeUnavailable: true }).find((f) => f.key === key),
      listFields: async (filter) => registry.listFields(filter),
    },
    events: {
      subscribe: (event, handler) => {
        events.subscribe(event, handler as (payload: unknown) => void, ctx.pluginName)
      },
    },
    ledger: {
      addEntry: async (input, c) => ledger.addEntry(input, ctxFor(ctx.pluginName, c)),
      reviseEntry: async (input, c) => ledger.reviseEntry(input, ctxFor(ctx.pluginName, c)),
      voidEntry: async (input, c) => ledger.voidEntry(input, ctxFor(ctx.pluginName, c)),
      getEntry: async (id) => ledger.getEntry(id),
      listEntries: async (filter) => ledger.listEntries(filter),
      listRevisions: async (entryId) => ledger.listRevisions(entryId),
      stats: async (kind, filter) => ledger.stats(kind, filter) as never,
    },
    services: {
      provide: (name, service) => services.provide(name, service, ctx.pluginName),
      get: (name) => services.get(name),
      onAvailable: (name, cb) => services.onAvailable(name, cb, ctx.pluginName),
    },
    log,
    meta: { pluginName: ctx.pluginName, dataDir: ctx.dataDir },
  }

  if (!isAdmin) return base

  const admin: AdminHostAPI = {
    ...base,
    plugins:
      deps.pluginsAdmin ??
      ({
        list: async () => {
          throw new Error('plugin admin not available in this context')
        },
      } as unknown as PluginAdminAPI),
    host:
      deps.hostControl ??
      ({
        info: async () => {
          throw new Error('host control not available in this context')
        },
      } as unknown as HostControlAPI),
  }
  return admin
}
