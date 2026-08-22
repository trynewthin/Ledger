import type { Direction, FieldEnumValue, StatsKind } from '@ledger/plugin-contract'
import { Dispatcher } from './dispatcher.js'
import { AppError } from './errors.js'
import { LedgerService } from './ledger.js'
import { PluginHost } from './plugin-host.js'
import { Registry } from './registry.js'
import { listEntriesSchema, parseOrThrow } from './validation.js'

/**
 * 命令注册表：entry.* / stats.* / type.* / field.* / plugin.*（admin）。
 * 业务命令与 admin 命令同一通道（统一调用协议）。
 */
export function registerCoreCommands(deps: {
  dispatcher: Dispatcher
  ledger: LedgerService
  registry: Registry
  pluginHost: PluginHost
}): void {
  const { dispatcher, ledger, registry, pluginHost } = deps

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

  for (const kind of ['summary', 'monthly', 'byType', 'byDirection'] as const) {
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

  // ---- 插件管理（admin 命令，白名单插件经 AdminHostAPI 调用；管理入口不唯一） ----
  dispatcher.register('plugin.list', () => pluginHost.list())
  dispatcher.register('plugin.unload', async (payload) => {
    const name = requireString(payload?.name, 'name')
    await pluginHost.unload(name, 'shutdown')
    return { unloaded: name }
  })
  dispatcher.register('commands.list', () => dispatcher.listCommands())
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new AppError('VALIDATION_ERROR', `payload.${field} must be a non-empty string`)
  }
  return v
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
