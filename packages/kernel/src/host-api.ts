import type {
  AdminHostAPI,
  CallContext,
  HostAPI,
  HostControlAPI,
  PluginAdminAPI,
  RpcRequest,
  RpcResult,
} from '@ledger/plugin-contract'
import { EventBus } from './event-bus.js'
import { LedgerService } from './ledger.js'
import { Registry } from './registry.js'
import { ServiceRegistry } from './services.js'
import { Dispatcher } from './dispatcher.js'
import type { Logger } from '@ledger/plugin-contract'
import type { ConfigValue, StorageValue } from '@ledger/plugin-contract'
import type { BookProvider, ConfigProvider, ProjectInitializationProvider, StorageProvider } from './core-services.js'

export interface HostApiDeps {
  registry: Registry
  events: EventBus
  ledger: LedgerService
  services: ServiceRegistry
  config: ConfigProvider
  storage: StorageProvider
  books: BookProvider
  initialization: ProjectInitializationProvider
  dispatcher: Dispatcher
  log: Logger
  pluginsAdmin?: PluginAdminAPI
  hostControl?: HostControlAPI
}

export interface HostApiContext {
  pluginName: string
  dataDir: string
  projectRoot: string
  configReads?: string[]
}

function ctxFor(name: string, ctx?: Partial<CallContext>): CallContext {
  return { source: ctx?.source ?? `plugin:${name}`, recorder: ctx?.recorder ?? 'me' }
}

/**
 * 能力面构造：所有插件获得 HostAPI；内核白名单（coreMaintainedPlugins）内获得 AdminHostAPI。
 * 托管项（注册表项/事件订阅/服务）按插件名打标，随 deactivate 自动反注册。
 */
export function createPluginHostApi(deps: HostApiDeps, ctx: HostApiContext, isAdmin: boolean): HostAPI | AdminHostAPI {
  const { registry, events, ledger, services, config, storage, initialization, books } = deps
  const assertConfigRead = (path: string): void => {
    const reads = ctx.configReads ?? []
    if (!reads.some((declared) => path === declared || path.startsWith(`${declared}.`))) {
      throw new Error(`plugin ${ctx.pluginName} did not declare config read: ${path}`)
    }
  }
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
    config: {
      get: async <T extends ConfigValue = ConfigValue>(path: string) => {
        assertConfigRead(path)
        return config.get<T>(path)
      },
      require: async <T extends ConfigValue = ConfigValue>(path: string) => {
        assertConfigRead(path)
        return config.require<T>(path)
      },
      snapshot: async () => {
        const out: Record<string, ConfigValue> = {}
        for (const path of ctx.configReads ?? []) {
          const value = config.get(path)
          if (value !== undefined) out[path] = value
        }
        return Object.freeze(out)
      },
      status: async () => config.status(),
      subscribe: (path, handler) => {
        assertConfigRead(path)
        config.subscribe(path, handler, ctx.pluginName)
      },
    },
    initialization: {
      projectRoot: ctx.projectRoot,
      register: (name, initialize) => initialization.register(name, ctx.pluginName, initialize),
    },
    storage: {
      get: async <T extends StorageValue = StorageValue>(key: string) => storage.get<T>(ctx.pluginName, key),
      set: async (key, value) => storage.set(ctx.pluginName, key, value),
      delete: async (key) => storage.delete(ctx.pluginName, key),
      list: async <T extends StorageValue = StorageValue>(prefix?: string) => storage.list<T>(ctx.pluginName, prefix),
      getProject: async <T extends StorageValue = StorageValue>(key: string) => storage.getProject<T>(ctx.pluginName, key),
      setProject: async (key, value) => storage.setProject(ctx.pluginName, key, value),
      deleteProject: async (key) => storage.deleteProject(ctx.pluginName, key),
      listProject: async <T extends StorageValue = StorageValue>(prefix?: string) => storage.listProject<T>(ctx.pluginName, prefix),
      exportAll: (options) => storage.exportAll(options),
      inspectImport: (source) => storage.inspectImport(source),
      importAll: (source, options) => storage.importAll(source, options),
      createSnapshot: () => storage.createSnapshot(),
      listSnapshots: () => storage.listSnapshots(),
      deleteSnapshot: (id) => storage.deleteSnapshot(id),
      switchSnapshot: (id) => storage.switchSnapshot(id),
    },
    books: {
      create: (input) => books.create(input),
      get: (id) => books.get(id),
      list: () => books.list(),
      current: () => books.current(),
      delete: (id) => books.delete(id),
      switch: (id) => books.switch(id),
    },
    dispatch: async (req: RpcRequest): Promise<RpcResult> =>
      deps.dispatcher.dispatch({
        command: req.command,
        payload: req.payload,
        context: {
          source: req.context?.source ?? `plugin:${ctx.pluginName}`,
          recorder: req.context?.recorder ?? 'me',
        },
      }),
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
