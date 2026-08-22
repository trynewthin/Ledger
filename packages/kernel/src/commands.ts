import type { Direction, FieldEnumValue, HostControlAPI, PluginAdminAPI, UserService } from '@ledger/plugin-contract'
import { Dispatcher } from './dispatcher.js'
import { AppError } from './errors.js'
import { LedgerService } from './ledger.js'
import { PluginHost } from './plugin-host.js'
import { Registry } from './registry.js'
import type { ServiceRegistry } from './services.js'
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
  admin?: PluginAdminAPI
  hostControl?: HostControlAPI
}): void {
  const { dispatcher, ledger, registry, pluginHost, services, admin, hostControl } = deps

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
