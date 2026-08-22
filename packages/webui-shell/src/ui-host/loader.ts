import type { UiHostAPI, UiPlugin } from '@ledger/webui-contract'
import { client } from '../lib/client.js'
import { useShellStore } from './store.js'

/**
 * UI 插件宿主：拉取清单 → 动态 import（cache-busting）→ activate → 贡献物入注册表。
 * 生产态加载后端 serve 的 ESM；开发态可改 BASE 为 vite dev server 的插件目录。
 * 热替换语义等同内核 L1 的注销-重载-重注册，失败保留旧版继续运行。
 */

export interface UiPluginManifestInfo {
  name: string
  version: string
  entry: string
}

const ENABLED_KEY = 'ledger.uiPlugins.enabled'

function readEnabled(): Record<string, boolean> {
  try {
    return JSON.parse(window.localStorage.getItem(ENABLED_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

function writeEnabled(map: Record<string, boolean>): void {
  window.localStorage.setItem(ENABLED_KEY, JSON.stringify(map))
}

export function isEnabled(name: string): boolean {
  return readEnabled()[name] ?? true
}

const active = new Map<string, UiPlugin>()

function makeHostApi(name: string): UiHostAPI {
  const store = useShellStore.getState()
  return {
    registry: {
      registerPage: (key, component, opts) => useShellStore.getState().register('pages', name, key, component, opts),
      registerWidget: (key, component, opts) => useShellStore.getState().register('widgets', name, key, component, opts),
      registerPanel: (key, component, opts) => useShellStore.getState().register('panels', name, key, component, opts),
    },
    client,
    store: { getState: () => useShellStore.getState() as unknown as Record<string, unknown> },
  }
}

async function loadOne(info: UiPluginManifestInfo): Promise<void> {
  const plugin = active.get(info.name)
  if (plugin) return
  const bust = `${info.entry}${info.entry.includes('?') ? '&' : '?'}t=${Date.now()}`
  const mod = (await import(/* @vite-ignore */ bust)) as { default?: UiPlugin } & Record<string, unknown>
  const p: UiPlugin | undefined =
    mod.default && 'activate' in (mod.default as object)
      ? (mod.default as UiPlugin)
      : (Object.values(mod).find((v) => !!v && typeof v === 'object' && 'activate' in (v as object)) as UiPlugin | undefined)
  if (!p) throw new Error(`${info.entry} does not export a UiPlugin`)
  await p.activate(makeHostApi(info.name))
  active.set(info.name, p)
  useShellStore.getState().patchPlugin(info.name, { name: p.manifest.name, version: p.manifest.version, active: true, error: undefined })
}

async function unloadOne(name: string): Promise<void> {
  const p = active.get(name)
  if (!p) return
  try {
    await p.deactivate()
  } finally {
    active.delete(name)
    useShellStore.getState().unregisterOwner(name)
    useShellStore.getState().patchPlugin(name, { active: false })
  }
}

export async function refreshManifest(): Promise<UiPluginManifestInfo[]> {
  const res = await fetch('/api/ui-plugins')
  const list = (await res.json()) as UiPluginManifestInfo[]
  const st = useShellStore.getState()
  st.setPlugins(list.map((l) => ({ name: l.name, version: l.version, active: active.has(l.name) })))
  return list
}

/** 启动时装载全部启用的 UI 插件（单个失败不影响其他） */
export async function bootUiPlugins(): Promise<void> {
  const list = await refreshManifest()
  for (const info of list) {
    if (!isEnabled(info.name)) continue
    try {
      await loadOne(info)
    } catch (e) {
      useShellStore.getState().patchPlugin(info.name, { active: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
}

/** 启停即时生效：停用 = deactivate + 反注册；启用 = 动态加载 */
export async function togglePlugin(name: string, enabled: boolean): Promise<void> {
  writeEnabled({ ...readEnabled(), [name]: enabled })
  if (enabled) {
    const list = await refreshManifest()
    const info = list.find((l) => l.name === name)
    if (info) await loadOne(info)
  } else {
    await unloadOne(name)
  }
}

/** 重新加载（热替换）：先卸旧再装新；失败保留旧版 */
export async function reloadPlugin(name: string): Promise<void> {
  const old = active.get(name)
  await unloadOne(name).catch(() => undefined)
  const list = await refreshManifest()
  const info = list.find((l) => l.name === name)
  if (!info) return
  try {
    await loadOne(info)
  } catch (e) {
    useShellStore.getState().patchPlugin(name, { active: false, error: e instanceof Error ? e.message : String(e) })
    if (old) {
      // 失败回退：重新激活旧实例
      await old.activate(makeHostApi(name)).catch(() => undefined)
      active.set(name, old)
      useShellStore.getState().patchPlugin(name, { active: true })
    }
  }
}
