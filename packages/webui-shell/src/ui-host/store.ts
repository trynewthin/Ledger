import { create } from 'zustand'
import type { UiComponent } from '@ledger/webui-contract'

export interface RegEntry {
  key: string
  label?: string
  order?: number
  component: UiComponent
  owner: string
}

export interface LoadedUiPlugin {
  name: string
  version: string
  active: boolean
  error?: string
}

interface ShellState {
  pages: RegEntry[]
  widgets: RegEntry[]
  panels: RegEntry[]
  plugins: LoadedUiPlugin[]
  register: (kind: 'pages' | 'widgets' | 'panels', owner: string, key: string, component: UiComponent, opts?: { label?: string; order?: number }) => void
  unregisterOwner: (owner: string) => void
  setPlugins: (plugins: LoadedUiPlugin[]) => void
  patchPlugin: (name: string, patch: Partial<LoadedUiPlugin>) => void
}

/** UI 插件注册表（shell 全局状态；托管项随 deactivate 自动反注册） */
export const useShellStore = create<ShellState>((set) => ({
  pages: [],
  widgets: [],
  panels: [],
  plugins: [],
  register: (kind, owner, key, component, opts) =>
    set((s) => ({
      [kind]: [...s[kind].filter((e) => e.key !== key), { key, component, owner, label: opts?.label, order: opts?.order }].sort(
        (a, b) => (a.order ?? 100) - (b.order ?? 100),
      ),
    } as Partial<ShellState>)),
  unregisterOwner: (owner) =>
    set((s) => ({
      pages: s.pages.filter((e) => e.owner !== owner),
      widgets: s.widgets.filter((e) => e.owner !== owner),
      panels: s.panels.filter((e) => e.owner !== owner),
    })),
  setPlugins: (plugins) => set({ plugins }),
  patchPlugin: (name, patch) =>
    set((s) => ({ plugins: s.plugins.map((p) => (p.name === name ? { ...p, ...patch } : p)) })),
}))
