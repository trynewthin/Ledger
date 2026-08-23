import type { CommandDescriptor, Direction, FieldEnumValue, HostControlAPI, PluginAdminAPI, SnapshotService, UserService } from '@ledger/plugin-contract'
import { Dispatcher } from './dispatcher.js'
import { AppError, type KernelErrorCode } from './errors.js'
import { LedgerService } from './ledger.js'
import { PluginHost } from './plugin-host.js'
import { Registry } from './registry.js'
import type { ServiceRegistry } from './services.js'
import type { StorageProvider } from './core-services.js'
import { listEntriesSchema, parseOrThrow } from './validation.js'

/**
 * 命令注册表：entry.* / stats.* / type.* / field.* / user.* / snapshot.* / plugin.*（admin）。
 * 业务命令与 admin 命令同一通道（统一调用协议）。
 * admin 注入时（常驻宿主），plugin.* 全集 + host.* 生效；否则仅冷引导子集。
 * user.* / snapshot.* 是薄转发：真实实现在服务提供者插件（不在场 → SERVICE_UNAVAILABLE）。
 */
export function registerCoreCommands(deps: {
  dispatcher: Dispatcher
  ledger: LedgerService
  registry: Registry
  pluginHost: PluginHost
  services: ServiceRegistry
  storage: StorageProvider
  admin?: PluginAdminAPI
  hostControl?: HostControlAPI
}): void {
  const { dispatcher, ledger, registry, pluginHost, services, storage, admin, hostControl } = deps

  const entryFilter = (payload: any) => (payload ? parseOrThrow(listEntriesSchema, payload, 'filter') : undefined)

  dispatcher.register('entry.add', (payload, ctx) => ledger.addEntry(payload, ctx))
  dispatcher.register('entry.revise', (payload, ctx) => ledger.reviseEntry(payload, ctx))
  dispatcher.register('entry.void', (payload, ctx) => ledger.voidEntry(payload, ctx))
  dispatcher.register('entry.get', (payload) => {
    const id = requireString(payload?.id, 'id')
    return ledger.getEntry(id)
  })
  dispatcher.register('entry.list', (payload) => ledger.listEntries(entryFilter(payload)))
  dispatcher.register('entry.revisions', (payload) => {
    const id = requireString(payload?.entryId ?? payload?.id, 'entryId')
    return ledger.listRevisions(id)
  })

  for (const kind of ['summary', 'monthly', 'byType', 'byDirection', 'byRecorder'] as const) {
    dispatcher.register(`stats.${kind}`, (payload) => ledger.stats(kind, entryFilter(payload)))
  }

  // ---- 用户运行时注册（与插件贡献并存，同一张注册表；origin: user） ----
  dispatcher.register('type.register', (payload) => {
    const def = parseTypeRegistration(payload)
    return registry.registerType(def, { origin: 'user', owner: 'user' })
  })
  dispatcher.register('type.list', (payload) =>
    registry.listTypes({
      direction: payload?.direction as Direction | undefined,
      includeUnavailable: payload?.includeUnavailable ?? true,
    }),
  )
  dispatcher.register('type.get', (payload) => {
    const key = requireString(payload?.key, 'key')
    const def = registry.getType(key)
    if (!def) throw new AppError('TYPE_NOT_REGISTERED', `type "${key}" is not registered`)
    return def
  })
  dispatcher.register('field.register', (payload) => {
    const def = parseFieldRegistration(payload)
    return registry.registerField(def, { origin: 'user', owner: 'user' })
  })
  dispatcher.register('field.list', (payload) =>
    registry.listFields({
      scope: payload?.scope as 'expense' | 'income' | 'both' | undefined,
      includeUnavailable: payload?.includeUnavailable ?? true,
    }),
  )
  dispatcher.register('field.get', (payload) => {
    const key = requireString(payload?.key, 'key')
    const def = registry.getField(key)
    if (!def) throw new AppError('FIELD_UNKNOWN', `field "${key}" is not registered`)
    return def
  })

  // ---- user.*：薄转发到 'user' 服务（plugin-user 提供；不在场则明确降级） ----
  dispatcher.register('user.get', (payload) => {
    const svc = requireUserService(services)
    const id = typeof payload?.id === 'string' && payload.id !== '' ? payload.id : svc.getUserId()
    const user = svc.getUser(id)
    if (!user) throw new AppError('USER_NOT_FOUND', `user "${id}" not found`)
    return user
  })
  dispatcher.register('user.list', () => requireUserService(services).listUsers())

  // ---- snapshot.*：薄转发到 'snapshot' 服务（plugin-snapshot 提供） ----
  dispatcher.register('snapshot.create', (payload) => {
    const svc = requireSnapshotService(services)
    const scope = payload?.scope === 'book' ? 'book' : 'full'
    const bookId = typeof payload?.bookId === 'string' && payload.bookId !== '' ? payload.bookId : 'default'
    return svc.create(scope, scope === 'book' ? bookId : undefined)
  })
  dispatcher.register('snapshot.list', () => requireSnapshotService(services).list())
  dispatcher.register('snapshot.restore', async (payload) => {
    const svc = requireSnapshotService(services)
    const file = requireString(payload?.file ?? payload?.path, 'file')
    try {
      const result = await svc.restore(file)
      // 回迁可能整表替换了 type_defs/field_defs：内核注册表重载（插件/用户定义均持久化于表）
      registry.load()
      return result
    } catch (e) {
      throw withCode(e, 'SNAPSHOT_NOT_FOUND', `snapshot restore failed`)
    }
  })

  // ---- Storage Core 快照：完整 SQLite 快照独立于 plugin-snapshot，可零插件使用 ----
  dispatcher.register('storage.snapshot.create', () => storage.createSnapshot())
  dispatcher.register('storage.snapshot.list', () => storage.listSnapshots())
  dispatcher.register('storage.snapshot.delete', async (payload) => {
    const id = requireString(payload?.id, 'id')
    try {
      await storage.deleteSnapshot(id)
      return { deleted: id }
    } catch (error) {
      throw withCode(error, 'SNAPSHOT_NOT_FOUND', `snapshot delete failed`)
    }
  })
  dispatcher.register('storage.snapshot.switch', async (payload) => {
    try {
      const result = await storage.switchSnapshot(requireString(payload?.id, 'id'))
      // 完整快照可能替换元数据表，立即使 Registry 回到快照对应的内存状态。
      registry.load()
      return result
    } catch (error) {
      throw withCode(error, 'SNAPSHOT_NOT_FOUND', `snapshot switch failed`)
    }
  })

  // ---- 插件管理（admin 命令；管理入口不唯一：任何白名单特权插件共用） ----
  dispatcher.register('plugin.list', () => (admin ? admin.list() : pluginHost.list()))
  if (admin) {
    dispatcher.register('plugin.load', async (payload) => {
      const name = requireString(payload?.name ?? payload?.target, 'name')
      return admin.load(name)
    })
    dispatcher.register('plugin.unload', async (payload) => {
      const name = requireString(payload?.name, 'name')
      await admin.unload(name)
      return { unloaded: name }
    })
    dispatcher.register('plugin.reload', async (payload) => {
      const name = requireString(payload?.name, 'name')
      return admin.reload(name)
    })
    dispatcher.register('plugin.install', async (payload) => {
      const dir = requireString(payload?.dir ?? payload?.sourceDir, 'dir')
      return admin.install(dir, payload?.opts)
    })
    dispatcher.register('plugin.uninstall', async (payload) => {
      const name = requireString(payload?.name, 'name')
      await admin.uninstall(name)
      return { uninstalled: name }
    })
    dispatcher.register('plugin.update', async (payload) => {
      const name = requireString(payload?.name, 'name')
      const dir = requireString(payload?.dir ?? payload?.sourceDir, 'dir')
      return admin.update(name, dir)
    })
  } else {
    dispatcher.register('plugin.unload', async (payload) => {
      const name = requireString(payload?.name, 'name')
      await pluginHost.unload(name, 'shutdown')
      return { unloaded: name }
    })
  }
  if (hostControl) {
    dispatcher.register('host.info', () => hostControl.info())
    dispatcher.register('host.shutdown', async () => {
      const info = await hostControl.info()
      setTimeout(() => void hostControl.shutdown(), 10)
      return { shuttingDown: true, pid: info.pid }
    })
  }
  dispatcher.register('commands.list', () => dispatcher.listCommands())
  dispatcher.register('commands.describe', () => dispatcher.describeCommands())
  applyCapabilityDescriptions(dispatcher)
}

type CapabilityDescription = Omit<CommandDescriptor, 'name'>

const FILTER_QUERY = {
  bookId: 'string',
  direction: 'string',
  type: 'string',
  recorder: 'string',
  from: 'number',
  to: 'number',
  includeVoided: 'boolean',
  limit: 'number',
  offset: 'number',
} as const

const ADD_ENTRY_SCHEMA = {
  type: 'object',
  required: ['direction', 'amountMinor', 'currency'],
  properties: {
    direction: { type: 'string', enum: ['income', 'expense'] },
    amountMinor: { type: 'integer', minimum: 1 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    type: { type: ['string', 'null'] },
    occurredAt: { type: 'number' },
    extra: { type: 'object' },
    strictExtra: { type: 'boolean' },
    bookId: { type: 'string' },
  },
} satisfies Record<string, unknown>

/**
 * 应用命令只声明能力事实和各协议的自然名称。HTTP/CLI/MCP 适配器消费这些描述，
 * 领域服务本身不依赖路由、子命令或 tool 名称。
 */
const CAPABILITIES: Record<string, CapabilityDescription> = {
  'entry.add': capability('entry', 'add', '记录一笔账目', {
    cli: { command: 'add' }, http: { method: 'POST', path: '/entries', successStatus: 201 }, mcp: { tool: 'add_entry' },
  }, ADD_ENTRY_SCHEMA),
  'entry.get': capability('entry', 'get', '读取一笔账目', {
    cli: { command: 'get' }, http: { method: 'GET', path: '/entries/:id' },
  }),
  'entry.list': capability('entry', 'list', '查询账目流水', {
    cli: { command: 'list' }, http: { method: 'GET', path: '/entries', query: FILTER_QUERY }, mcp: { tool: 'list_entries' },
  }),
  'entry.revise': capability('entry', 'revise', '修订账目并保留前像', {
    cli: { command: 'revise' }, http: { method: 'PATCH', path: '/entries/:id' }, mcp: { tool: 'revise_entry' },
  }),
  'entry.void': capability('entry', 'void', '软作废一笔账目', {
    cli: { command: 'void' }, http: { method: 'POST', path: '/entries/:id/void' }, mcp: { tool: 'void_entry' },
  }),
  'entry.revisions': capability('entry', 'revisions', '读取账目修订历史', {
    http: { method: 'GET', path: '/entries/:entryId/revisions' },
  }),
  'stats.summary': capability('stats', 'summary', '汇总收支与净额', {
    cli: { command: 'stats summary' }, http: { method: 'GET', path: '/stats/summary', query: FILTER_QUERY }, mcp: { tool: 'get_stats', variant: 'summary' },
  }),
  'stats.monthly': capability('stats', 'monthly', '按月统计收支', {
    cli: { command: 'stats monthly' }, http: { method: 'GET', path: '/stats/monthly', query: FILTER_QUERY }, mcp: { tool: 'get_stats', variant: 'monthly' },
  }),
  'stats.byType': capability('stats', 'byType', '按类型统计', {
    cli: { command: 'stats by-type' }, http: { method: 'GET', path: '/stats/by-type', query: FILTER_QUERY }, mcp: { tool: 'get_stats', variant: 'byType' },
  }),
  'stats.byDirection': capability('stats', 'byDirection', '按方向统计', {
    cli: { command: 'stats by-direction' }, http: { method: 'GET', path: '/stats/by-direction', query: FILTER_QUERY }, mcp: { tool: 'get_stats', variant: 'byDirection' },
  }),
  'stats.byRecorder': capability('stats', 'byRecorder', '按记录者统计', {
    cli: { command: 'stats by-recorder' }, http: { method: 'GET', path: '/stats/by-recorder', query: FILTER_QUERY }, mcp: { tool: 'get_stats', variant: 'byRecorder' },
  }),
  'type.register': capability('type', 'register', '注册账目类型', {
    cli: { command: 'type add' }, http: { method: 'POST', path: '/types', successStatus: 201 },
  }),
  'type.list': capability('type', 'list', '列出账目类型', {
    cli: { command: 'type list' }, http: { method: 'GET', path: '/types', query: { direction: 'string', includeUnavailable: 'boolean' } }, mcp: { tool: 'list_types' },
  }),
  'type.get': capability('type', 'get', '读取账目类型', { http: { method: 'GET', path: '/types/:key' } }),
  'field.register': capability('field', 'register', '注册动态字段', {
    cli: { command: 'field add' }, http: { method: 'POST', path: '/fields', successStatus: 201 }, mcp: { tool: 'register_field' },
  }),
  'field.list': capability('field', 'list', '列出动态字段', {
    cli: { command: 'field list' }, http: { method: 'GET', path: '/fields', query: { scope: 'string', includeUnavailable: 'boolean' } }, mcp: { tool: 'list_fields' },
  }),
  'field.get': capability('field', 'get', '读取动态字段', { http: { method: 'GET', path: '/fields/:key' } }),
  'user.get': capability('user', 'get', '读取身份', { cli: { command: 'user get' }, http: { method: 'GET', path: '/users/:id' } }),
  'user.list': capability('user', 'list', '列出身份', { cli: { command: 'user list' }, http: { method: 'GET', path: '/users' } }),
  'snapshot.create': capability('snapshot', 'create', '创建存储快照', { cli: { command: 'snapshot create' }, http: { method: 'POST', path: '/snapshots', successStatus: 201 } }),
  'snapshot.list': capability('snapshot', 'list', '列出存储快照', { cli: { command: 'snapshot list' }, http: { method: 'GET', path: '/snapshots' } }),
  'snapshot.restore': capability('snapshot', 'restore', '恢复存储快照', { cli: { command: 'snapshot restore' }, http: { method: 'POST', path: '/snapshots/:file/restore' } }),
  'storage.snapshot.create': capability('storage.snapshot', 'create', '创建完整存储快照', {
    cli: { command: 'storage snapshot create' }, http: { method: 'POST', path: '/storage/snapshots', successStatus: 201 },
  }),
  'storage.snapshot.list': capability('storage.snapshot', 'list', '列出完整存储快照', {
    cli: { command: 'storage snapshot list' }, http: { method: 'GET', path: '/storage/snapshots' },
  }),
  'storage.snapshot.delete': capability('storage.snapshot', 'delete', '删除完整存储快照', {
    cli: { command: 'storage snapshot delete' }, http: { method: 'DELETE', path: '/storage/snapshots/:id' },
  }),
  'storage.snapshot.switch': capability('storage.snapshot', 'switch', '切换到完整存储快照', {
    cli: { command: 'storage snapshot switch' }, http: { method: 'POST', path: '/storage/snapshots/:id/switch' },
  }),
  'plugin.list': capability('plugin', 'list', '列出插件', { cli: { command: 'plugin list' }, http: { method: 'GET', path: '/plugins' } }),
  'plugin.load': capability('plugin', 'load', '加载已安装插件', { cli: { command: 'plugin load' }, http: { method: 'POST', path: '/plugins/:name/load' } }),
  'plugin.unload': capability('plugin', 'unload', '停用插件', { http: { method: 'POST', path: '/plugins/:name/unload' } }),
  'plugin.reload': capability('plugin', 'reload', '热重载插件', { cli: { command: 'plugin reload' }, http: { method: 'POST', path: '/plugins/:name/reload' } }),
  'plugin.install': capability('plugin', 'install', '安装插件', { cli: { command: 'plugin install' }, http: { method: 'POST', path: '/plugins/install', successStatus: 201 } }),
  'plugin.uninstall': capability('plugin', 'uninstall', '卸载插件', { cli: { command: 'plugin uninstall' }, http: { method: 'DELETE', path: '/plugins/:name' } }),
  'plugin.update': capability('plugin', 'update', '更新插件', { http: { method: 'PUT', path: '/plugins/:name' } }),
  'host.info': capability('host', 'info', '读取宿主状态', { http: { method: 'GET', path: '/host' } }),
  'host.shutdown': capability('host', 'shutdown', '关闭常驻宿主', { http: { method: 'POST', path: '/host/shutdown' } }),
  'commands.list': capability('commands', 'list', '列出应用命令名称', { http: { method: 'GET', path: '/commands' } }),
  'commands.describe': capability('commands', 'describe', '读取应用能力目录', { http: { method: 'GET', path: '/capabilities' } }),
}

function capability(
  domain: string,
  action: string,
  description: string,
  exposure: NonNullable<CommandDescriptor['exposure']>,
  inputSchema?: Record<string, unknown>,
): CapabilityDescription {
  return { domain, action, description, exposure, ...(inputSchema ? { inputSchema } : {}) }
}

function applyCapabilityDescriptions(dispatcher: Dispatcher): void {
  for (const [name, descriptor] of Object.entries(CAPABILITIES)) {
    if (dispatcher.has(name)) dispatcher.describe(name, descriptor)
  }
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new AppError('VALIDATION_ERROR', `payload.${field} must be a non-empty string`)
  }
  return v
}

function requireUserService(services: ServiceRegistry): UserService {
  const svc = services.get<UserService>('user')
  if (!svc) {
    throw new AppError('SERVICE_UNAVAILABLE', `service "user" is not available (install/enable plugin-user)`)
  }
  return svc
}

function requireSnapshotService(services: ServiceRegistry): SnapshotService {
  const svc = services.get<SnapshotService>('snapshot')
  if (!svc) {
    throw new AppError('SERVICE_UNAVAILABLE', `service "snapshot" is not available (install/enable plugin-snapshot)`)
  }
  return svc
}

/** 服务层携带 code 的错误 → AppError（保持类型化错误码贯穿）；其余原样抛出 */
function withCode(e: unknown, code: KernelErrorCode, fallbackMessage: string): unknown {
  const coded = e as { code?: unknown; message?: unknown }
  if (e instanceof Error && coded.code === code) {
    return new AppError(code, typeof coded.message === 'string' ? coded.message : fallbackMessage)
  }
  return e
}

function parseTypeRegistration(payload: any) {
  return {
    key: requireString(payload?.key, 'key'),
    label: requireString(payload?.label, 'label'),
    direction: parseDirection(payload?.direction),
    parentKey: payload?.parentKey ?? null,
    icon: payload?.icon ?? null,
    schema: payload?.schema ?? null,
    overwrite: payload?.overwrite ?? false,
  }
}

function parseFieldRegistration(payload: any) {
  const valueType = payload?.valueType
  if (!['string', 'number', 'enum', 'date', 'boolean'].includes(valueType)) {
    throw new AppError('VALIDATION_ERROR', `valueType must be one of string|number|enum|date|boolean`)
  }
  const scope = payload?.scope
  if (!['expense', 'income', 'both'].includes(scope)) {
    throw new AppError('VALIDATION_ERROR', `scope must be one of expense|income|both`)
  }
  return {
    key: requireString(payload?.key, 'key'),
    label: requireString(payload?.label, 'label'),
    scope,
    valueType,
    enumValues: (payload?.enumValues as FieldEnumValue[] | undefined) ?? undefined,
    overwrite: payload?.overwrite ?? false,
  }
}

function parseDirection(v: unknown): Direction {
  if (v !== 'income' && v !== 'expense') {
    throw new AppError('VALIDATION_ERROR', 'direction must be income|expense')
  }
  return v
}
