import {
  AppError,
  installPluginDir,
  listInstalledPlugins,
  type Kernel,
} from '@ledger/kernel'
import type {
  HostControlAPI,
  HostInfo,
  PluginAdminAPI,
  PluginInfo,
} from '@ledger/plugin-contract'
import type { WorkerSupervisor } from './supervisor.js'

export interface HostRuntime {
  startedAt: number
  shutdown(): Promise<void>
}

/**
 * PluginAdminAPI 门面：统一 L1（PluginHost）与 L2（supervisor）的生命周期，
 * 加上安装管理（文件 + 配置）。管理能力属于内核——宿主只是注入者。
 */
export function createAdminFaces(
  getKernel: () => Kernel,
  getSupervisor: () => WorkerSupervisor,
  home: string,
  runtime: HostRuntime,
): { plugins: PluginAdminAPI; host: HostControlAPI } {
  const plugins: PluginAdminAPI = {
    async list(): Promise<PluginInfo[]> {
      const kernel = getKernel()
      return [...kernel.pluginHost.list(), ...getSupervisor().states()]
    },

    async load(target: string): Promise<PluginInfo> {
      const installed = await listInstalledPlugins(home)
      const found = installed.find((p) => p.name === target)
      if (!found) throw new AppError('PLUGIN_NOT_FOUND', `plugin not installed: ${target}`)
      if (found.manifest.isolation === 'worker') {
        await getSupervisor().start(found.name, found.dir)
      } else {
        await getKernel().pluginHost.loadFile(found.dir)
      }
      return (await plugins.list()).find((p) => p.name === found.name)!
    },

    async unload(name: string): Promise<void> {
      const supervisor = getSupervisor()
      if (supervisor.get(name)) {
        await supervisor.stop(name, 'shutdown')
        return
      }
      await getKernel().pluginHost.unload(name, 'shutdown')
    },

    async reload(name: string): Promise<PluginInfo> {
      const supervisor = getSupervisor()
      if (supervisor.get(name)) return supervisor.reload(name)
      await getKernel().pluginHost.reload(name)
      return (await plugins.list()).find((p) => p.name === name)!
    },

    async install(sourceDir: string, opts?: { enabled?: boolean }): Promise<PluginInfo> {
      const installed = await installPluginDir(sourceDir, home)
      if (opts?.enabled === false) {
        const { setPluginEnabled } = await import('@ledger/kernel')
        await setPluginEnabled(installed.name, home, false)
      }
      return (await plugins.list()).find((p) => p.name === installed.name) ?? {
        name: installed.name,
        version: installed.manifest.version ?? '?',
        isolation: (installed.manifest.isolation ?? 'inprocess') as 'inprocess' | 'worker',
        state: 'inactive' as const,
      }
    },

    async uninstall(name: string): Promise<void> {
      await plugins.unload(name).catch(() => undefined)
      const { uninstallPluginDir } = await import('@ledger/kernel')
      await uninstallPluginDir(name, home)
    },

    async update(name: string, sourceDir: string): Promise<PluginInfo> {
      const supervisor = getSupervisor()
      const running = supervisor.get(name) ?? getKernel().pluginHost.get(name)
      await installPluginDir(sourceDir, home)
      if (supervisor.get(name)) {
        await supervisor.reload(name)
      } else if (getKernel().pluginHost.get(name)) {
        await getKernel().pluginHost.reload(name)
      }
      if (!running && !(await plugins.list()).some((p) => p.name === name && p.state === 'active')) {
        // 未运行时仅更新文件
      }
      return (await plugins.list()).find((p) => p.name === name)!
    },
  }

  const host: HostControlAPI = {
    async info(): Promise<HostInfo> {
      return {
        name: 'ledger-host',
        pid: process.pid,
        startedAt: runtime.startedAt,
        uptimeMs: Date.now() - runtime.startedAt,
        plugins: await plugins.list(),
      }
    },
    async shutdown(): Promise<void> {
      await runtime.shutdown()
    },
  }

  return { plugins, host }
}
