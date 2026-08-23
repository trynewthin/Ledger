import type {
  CommandDescriptor,
  Direction,
  FieldEnumValue,
  HostControlAPI,
  PluginAdminAPI,
  TagService,
  UserService,
} from '@ledger/plugin-contract'
import { Dispatcher } from './dispatcher.js'
import { AppError } from './errors.js'
import { LedgerService } from './ledger.js'
import { PluginHost } from './plugin-host.js'
import { Registry } from './registry.js'
import type { ServiceRegistry } from './services.js'
import type { BookProvider } from './core-services.js'
import { listEntriesSchema, parseOrThrow } from './validation.js'

/**
 * 命令注册表：entry.* / stats.* / type.* / field.* / book.* / tag.* / user.* / plugin.*（admin）。
 * 业务命令与 admin 命令同一通道（统一调用协议）。
 * admin 注入时（常驻宿主），plugin.* 全集 + host.* 生效；否则仅冷引导子集。
 * user.* / tag.* 是薄转发：真实实现在服务提供者插件（不在场 → SERVICE_UNAVAILABLE）。
 */
export function registerCoreCommands(deps: {
  dispatcher: Dispatcher
  ledger: LedgerService
  registry: Registry
  pluginHost: PluginHost
  services: ServiceRegistry
  books: BookProvider
  admin?: PluginAdminAPI
  hostControl?: HostControlAPI
}): void {
  const { dispatcher, ledger, registry, pluginHost, services, books, admin, hostControl } = deps

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

  // ---- book.*：Book Core 是完整项目状态的唯一业务入口 ----
  dispatcher.register('book.create', (payload) => books.create({ name: requireString(payload?.name, 'name') }))
  dispatcher.register('book.list', () => books.list())
  dispatcher.register('book.get', (payload) => books.get(requireString(payload?.id, 'id')))
  dispatcher.register('book.current', () => books.current())
  dispatcher.register('book.delete', async (payload) => {
    const id = requireString(payload?.id, 'id')
    await books.delete(id)
    return { deleted: id }
  })
  dispatcher.register('book.switch', async (payload) => {
    const result = await books.switch(requireString(payload?.id, 'id'))
    // 账本数据快照可能替换注册表表；立即重建内存视图。
    registry.load()
    return result
  })

  // ---- tag.*：薄转发到 'tags' 服务（plugin-core-types 提供） ----
  // 绑定只接受 tagId；标签组始终由标签所属关系反查，避免 book_tags 冗余 groupId。
  dispatcher.register('tag-group.create', (payload) =>
    invokeTagService(() => requireTagService(services).createGroup({ name: requireString(payload?.name, 'name') })),
  )
  dispatcher.register('tag-group.list', () => invokeTagService(() => requireTagService(services).listGroups()))
  dispatcher.register('tag-group.get', (payload) =>
    invokeTagService(() => requireTagService(services).getGroup(requireString(payload?.id, 'id'))),
  )
  dispatcher.register('tag-group.update', (payload) =>
    invokeTagService(() => requireTagService(services).updateGroup({
      id: requireString(payload?.id, 'id'),
      name: requireString(payload?.name, 'name'),
    })),
  )
  dispatcher.register('tag-group.delete', async (payload) => {
    const id = requireString(payload?.id, 'id')
    await invokeTagService(() => requireTagService(services).deleteGroup(id))
    return { deleted: id }
  })
  dispatcher.register('tag.create', (payload) =>
    invokeTagService(() => requireTagService(services).createTag({
      groupId: requireString(payload?.groupId, 'groupId'),
      name: requireString(payload?.name, 'name'),
    })),
  )
  dispatcher.register('tag.list', (payload) =>
    invokeTagService(() => requireTagService(services).listTags(
      typeof payload?.groupId === 'string' && payload.groupId !== '' ? { groupId: payload.groupId } : undefined,
    )),
  )
  dispatcher.register('tag.get', (payload) =>
    invokeTagService(() => requireTagService(services).getTag(requireString(payload?.id, 'id'))),
  )
  dispatcher.register('tag.update', (payload) =>
    invokeTagService(() => requireTagService(services).updateTag({
      id: requireString(payload?.id, 'id'),
      ...(payload?.groupId !== undefined ? { groupId: requireString(payload.groupId, 'groupId') } : {}),
      ...(payload?.name !== undefined ? { name: requireString(payload.name, 'name') } : {}),
    })),
  )
  dispatcher.register('tag.delete', async (payload) => {
    const id = requireString(payload?.id, 'id')
    await invokeTagService(() => requireTagService(services).deleteTag(id))
    return { deleted: id }
  })
  dispatcher.register('book.tag.bind', (payload) =>
    invokeTagService(() => requireTagService(services).bindBookTags({
      bookId: requireString(payload?.bookId, 'bookId'),
      tagIds: requireStringArray(payload?.tagIds, 'tagIds'),
    })),
  )
  dispatcher.register('book.tag.unbind', (payload) =>
    invokeTagService(() => requireTagService(services).unbindBookTags({
      bookId: requireString(payload?.bookId, 'bookId'),
      tagIds: requireStringArray(payload?.tagIds, 'tagIds'),
    })),
  )
  dispatcher.register('book.tag.list', (payload) =>
    invokeTagService(() => requireTagService(services).listBookTags(requireString(payload?.bookId ?? payload?.id, 'bookId'))),
  )

  // ---- user.*：薄转发到 'user' 服务（plugin-user 提供；不在场则明确降级） ----
  dispatcher.register('user.get', (payload) => {
    const svc = requireUserService(services)
    const id = typeof payload?.id === 'string' && payload.id !== '' ? payload.id : svc.getUserId()
    const user = svc.getUser(id)
    if (!user) throw new AppError('USER_NOT_FOUND', `user "${id}" not found`)
    return user
  })
  dispatcher.register('user.list', () => requireUserService(services).listUsers())

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
  'book.create': capability('book', 'create', '保存当前完整项目状态为账本', {
    cli: { command: 'book create' }, http: { method: 'POST', path: '/books', successStatus: 201 },
  }),
  'book.list': capability('book', 'list', '列出账本', { cli: { command: 'book list' }, http: { method: 'GET', path: '/books' } }),
  'book.get': capability('book', 'get', '读取账本', { http: { method: 'GET', path: '/books/:id' } }),
  'book.current': capability('book', 'current', '读取当前账本', { cli: { command: 'book current' }, http: { method: 'GET', path: '/books/current' } }),
  'book.delete': capability('book', 'delete', '删除非当前账本', { cli: { command: 'book delete' }, http: { method: 'DELETE', path: '/books/:id' } }),
  'book.switch': capability('book', 'switch', '切换完整项目状态到指定账本', {
    cli: { command: 'book switch' }, http: { method: 'POST', path: '/books/:id/switch' },
  }),
  'tag-group.create': capability('tag-group', 'create', '创建标签组', {
    cli: { command: 'tag group create' }, http: { method: 'POST', path: '/tag-groups', successStatus: 201 },
  }),
  'tag-group.list': capability('tag-group', 'list', '列出标签组', {
    cli: { command: 'tag group list' }, http: { method: 'GET', path: '/tag-groups' },
  }),
  'tag-group.get': capability('tag-group', 'get', '读取标签组', { http: { method: 'GET', path: '/tag-groups/:id' } }),
  'tag-group.update': capability('tag-group', 'update', '更新标签组', { http: { method: 'PATCH', path: '/tag-groups/:id' } }),
  'tag-group.delete': capability('tag-group', 'delete', '删除标签组及其标签绑定', { http: { method: 'DELETE', path: '/tag-groups/:id' } }),
  'tag.create': capability('tag', 'create', '在标签组中创建标签', {
    cli: { command: 'tag create' }, http: { method: 'POST', path: '/tags', successStatus: 201 },
  }),
  'tag.list': capability('tag', 'list', '列出标签', {
    cli: { command: 'tag list' }, http: { method: 'GET', path: '/tags', query: { groupId: 'string' } },
  }),
  'tag.get': capability('tag', 'get', '读取标签', { http: { method: 'GET', path: '/tags/:id' } }),
  'tag.update': capability('tag', 'update', '更新或移动标签', { http: { method: 'PATCH', path: '/tags/:id' } }),
  'tag.delete': capability('tag', 'delete', '删除标签及其账目绑定', { http: { method: 'DELETE', path: '/tags/:id' } }),
  'book.tag.bind': capability('book.tag', 'bind', '为账本绑定标签', {
    cli: { command: 'book tag bind' }, http: { method: 'POST', path: '/books/:bookId/tags' },
  }),
  'book.tag.list': capability('book.tag', 'list', '读取账本标签及反查标签组', {
    cli: { command: 'book tag list' }, http: { method: 'GET', path: '/books/:bookId/tags' },
  }),
  'book.tag.unbind': capability('book.tag', 'unbind', '解除账本标签绑定', {
    cli: { command: 'book tag unbind' }, http: { method: 'DELETE', path: '/books/:bookId/tags' },
  }),
  'user.get': capability('user', 'get', '读取身份', { cli: { command: 'user get' }, http: { method: 'GET', path: '/users/:id' } }),
  'user.list': capability('user', 'list', '列出身份', { cli: { command: 'user list' }, http: { method: 'GET', path: '/users' } }),
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

function requireStringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new AppError('VALIDATION_ERROR', `payload.${field} must be a non-empty string array`)
  }
  return [...new Set(v)]
}

function requireUserService(services: ServiceRegistry): UserService {
  const svc = services.get<UserService>('user')
  if (!svc) {
    throw new AppError('SERVICE_UNAVAILABLE', `service "user" is not available (install/enable plugin-user)`)
  }
  return svc
}

function requireTagService(services: ServiceRegistry): TagService {
  const svc = services.get<TagService>('tags')
  if (!svc) {
    throw new AppError('SERVICE_UNAVAILABLE', `service "tags" is not available (install/enable plugin-core-types)`)
  }
  return svc
}

/** 标签插件以 Error.code 表示可预期失败；在内核边界转成统一错误模型。 */
async function invokeTagService<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof AppError) throw error
    const coded = error as { code?: unknown; message?: unknown }
    const code = coded.code
    if (
      error instanceof Error
      && (code === 'VALIDATION_ERROR'
        || code === 'TAG_GROUP_NOT_FOUND'
        || code === 'TAG_GROUP_NAME_TAKEN'
        || code === 'TAG_NOT_FOUND'
        || code === 'TAG_NAME_TAKEN')
    ) {
      throw new AppError(code, typeof coded.message === 'string' ? coded.message : 'tag service request failed')
    }
    throw error
  }
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
