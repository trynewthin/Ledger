import { access, cp, mkdir, readdir, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Kernel } from './kernel.js'
import { loadPluginFromDir, readPluginDirManifest, type PluginDirManifest } from './loader.js'
import { AppError } from './errors.js'

export interface PluginsConfig {
  plugins: Record<string, { enabled: boolean }>
}

export function pluginsDirOf(home: string): string {
  return join(home, 'plugins')
}

export function pluginsConfigPath(home: string): string {
  return join(home, 'plugins.json')
}

export async function readPluginsConfig(home: string): Promise<PluginsConfig> {
  const { readFile } = await import('node:fs/promises')
  try {
    return JSON.parse(await readFile(pluginsConfigPath(home), 'utf8')) as PluginsConfig
  } catch {
    return { plugins: {} }
  }
}

export async function writePluginsConfig(home: string, config: PluginsConfig): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await mkdir(home, { recursive: true })
  await writeFile(pluginsConfigPath(home), JSON.stringify(config, null, 2) + '\n', 'utf8')
}

export interface InstalledPlugin {
  name: string
  dir: string
  manifest: PluginDirManifest
  enabled: boolean
}

export async function listInstalledPlugins(home: string): Promise<InstalledPlugin[]> {
  const dir = pluginsDirOf(home)
  const config = await readPluginsConfig(home)
  const out: InstalledPlugin[] = []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return out
  }
  for (const name of entries.sort()) {
    const pluginDir = join(dir, name)
    try {
      const manifest = await readPluginDirManifest(pluginDir)
      out.push({
        name: manifest.name || name,
        dir: pluginDir,
        manifest,
        enabled: config.plugins[manifest.name ?? name]?.enabled ?? true,
      })
    } catch {
      // 无 plugin.json 的目录跳过
    }
  }
  return out
}

/** 安装：复制 plugin.json + main 所在目录（dist）到 plugins/<name>，登记启用 */
export async function installPluginDir(sourceDir: string, home: string): Promise<InstalledPlugin> {
  const manifest = await readPluginDirManifest(sourceDir)
  const target = join(pluginsDirOf(home), manifest.name)
  await rm(target, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  await cp(sourceDir, target, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(sourceDir.length)
      // 只携带运行所需：目录、plugin.json、dist、shell 前端产物、静态资产、根级入口脚本
      return (
        rel === '' ||
        rel === '/plugin.json' ||
        rel.startsWith('/dist') ||
        rel.startsWith('/shell') ||
        rel.startsWith('/assets') ||
        /^\/[^/]+\.(mjs|cjs|js|json|css|html)$/.test(rel)
      )
    },
  })
  const config = await readPluginsConfig(home)
  config.plugins[manifest.name] = { enabled: true }
  await writePluginsConfig(home, config)
  return { name: manifest.name, dir: target, manifest, enabled: true }
}

export async function uninstallPluginDir(name: string, home: string): Promise<void> {
  const installed = await listInstalledPlugins(home)
  const target = installed.find((p) => p.name === name)
  if (!target) throw new AppError('PLUGIN_NOT_FOUND', `plugin not installed: ${name}`)
  await rm(target.dir, { recursive: true, force: true })
  const config = await readPluginsConfig(home)
  delete config.plugins[name]
  await writePluginsConfig(home, config)
}

export async function setPluginEnabled(name: string, home: string, enabled: boolean): Promise<void> {
  const config = await readPluginsConfig(home)
  if (!config.plugins[name]) config.plugins[name] = { enabled }
  else config.plugins[name]!.enabled = enabled
  await writePluginsConfig(home, config)
}

// ---------------------------------------------------------------------------
// UI 插件（webui shell 内的浏览器插件）目录管理
// ---------------------------------------------------------------------------

export interface UiPluginDirManifest {
  name: string
  version?: string
  entry?: string
}

export function uiPluginsDirOf(home: string): string {
  return join(home, 'ui-plugins')
}

export interface InstalledUiPlugin {
  name: string
  version: string
  entry: string
  dir: string
}

export async function listUiPlugins(home: string): Promise<InstalledUiPlugin[]> {
  const dir = uiPluginsDirOf(home)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const out: InstalledUiPlugin[] = []
  for (const name of entries.sort()) {
    const pluginDir = join(dir, name)
    try {
      const raw = JSON.parse(await (await import('node:fs/promises')).readFile(join(pluginDir, 'ui-plugin.json'), 'utf8')) as UiPluginDirManifest
      out.push({
        name: raw.name ?? name,
        version: raw.version ?? '0.0.0',
        entry: raw.entry ?? './index.js',
        dir: pluginDir,
      })
    } catch {
      // 无 ui-plugin.json 的目录跳过
    }
  }
  return out
}

/** 安装 UI 插件目录（复制 index/assets/ui-plugin.json） */
export async function installUiPluginDir(sourceDir: string, home: string): Promise<InstalledUiPlugin> {
  const { readFile } = await import('node:fs/promises')
  let manifest: UiPluginDirManifest
  try {
    manifest = JSON.parse(await readFile(join(sourceDir, 'ui-plugin.json'), 'utf8')) as UiPluginDirManifest
  } catch {
    throw new AppError('PLUGIN_LOAD_FAILED', `missing/invalid ui-plugin.json in ${sourceDir}`)
  }
  const target = join(uiPluginsDirOf(home), manifest.name)
  await rm(target, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  await cp(sourceDir, target, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(sourceDir.length)
      return (
        rel === '' ||
        rel === '/ui-plugin.json' ||
        /^\/[^/]+\.(mjs|js|css|json|html|svg|png)$/.test(rel) ||
        rel.startsWith('/assets')
      )
    },
  })
  return { name: manifest.name, version: manifest.version ?? '0.0.0', entry: manifest.entry ?? './index.js', dir: target }
}

export async function uninstallUiPluginDir(name: string, home: string): Promise<void> {
  const installed = await listUiPlugins(home)
  const target = installed.find((p) => p.name === name)
  if (!target) throw new AppError('PLUGIN_NOT_FOUND', `ui plugin not installed: ${name}`)
  await rm(target.dir, { recursive: true, force: true })
}

async function dirExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 引导已安装插件：仅 L1（inprocess）进本进程；worker 隔离跳过（需常驻宿主）。
 * 返回实际加载与跳过的名字，供宿主/入口报告。
 */
export async function bootstrapInstalledPlugins(
  kernel: Kernel,
  home: string,
  opts?: { onWorker?: (name: string, dir: string) => Promise<void> },
): Promise<{ loaded: string[]; workers: string[]; skippedWorker: string[]; skippedDisabled: string[]; failed: { name: string; error: string }[] }> {
  const installed = await listInstalledPlugins(home)
  const loaded: string[] = []
  const workers: string[] = []
  const skippedWorker: string[] = []
  const skippedDisabled: string[] = []
  const failed: { name: string; error: string }[] = []
  for (const p of installed) {
    if (!p.enabled) {
      skippedDisabled.push(p.name)
      continue
    }
    try {
      const plugin = await loadPluginFromDir(p.dir)
      if (plugin.manifest.isolation === 'worker') {
        if (opts?.onWorker) {
          await opts.onWorker(plugin.manifest.name, p.dir)
          workers.push(plugin.manifest.name)
        } else {
          skippedWorker.push(p.name)
        }
        continue
      }
      await kernel.pluginHost.load(plugin)
      // 记录 modulePath，供 L1 热替换
      const rec = kernel.pluginHost.records_().get(plugin.manifest.name)
      if (rec) (rec as { modulePath?: string }).modulePath = p.dir
      loaded.push(p.name)
    } catch (e) {
      // 坏插件不拖垮宿主：记录后继续
      failed.push({ name: p.name, error: e instanceof Error ? e.message : String(e) })
      kernel.pluginHost.deps.log.warn(`failed to load plugin ${p.name}: ${failed.at(-1)?.error}`)
    }
  }
  return { loaded, workers, skippedWorker, skippedDisabled, failed }
}
