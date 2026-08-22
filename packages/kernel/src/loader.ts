import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LedgerPlugin } from '@ledger/plugin-contract'
import { AppError } from './errors.js'

/** 插件目录清单：安装身份与入口（模块内 manifest 是运行时权威） */
export interface PluginDirManifest {
  name: string
  main: string
  version?: string
  isolation?: 'inprocess' | 'worker'
}

export async function readPluginDirManifest(dir: string): Promise<PluginDirManifest> {
  let raw: string
  try {
    raw = await readFile(join(dir, 'plugin.json'), 'utf8')
  } catch {
    throw new AppError('PLUGIN_LOAD_FAILED', `missing plugin.json in ${dir}`)
  }
  try {
    const manifest = JSON.parse(raw) as PluginDirManifest
    if (!manifest.name || !manifest.main) {
      throw new AppError('PLUGIN_LOAD_FAILED', `plugin.json in ${dir} requires name and main`)
    }
    return manifest
  } catch (e) {
    if (e instanceof AppError) throw e
    throw new AppError('PLUGIN_LOAD_FAILED', `invalid plugin.json in ${dir}: ${e instanceof Error ? e.message : e}`)
  }
}

/**
 * 从目录加载插件（ESM 动态导入）。
 * bust=true 追加 cache-busting 参数——L1 热替换时拿新模块而非模块缓存。
 */
export async function loadPluginFromDir(dir: string, opts?: { bust?: boolean }): Promise<LedgerPlugin> {
  const fileManifest = await readPluginDirManifest(dir)
  let entryUrl = pathToFileURL(resolve(dir, fileManifest.main)).href
  if (opts?.bust) entryUrl += `?t=${Date.now()}`
  let mod: Record<string, unknown>
  try {
    mod = (await import(entryUrl)) as Record<string, unknown>
  } catch (e) {
    throw new AppError(
      'PLUGIN_LOAD_FAILED',
      `failed to import ${entryUrl}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  const isPluginLike = (v: unknown): v is LedgerPlugin =>
    !!v && typeof v === 'object' && 'manifest' in v && typeof (v as LedgerPlugin).activate === 'function'
  const plugin = (mod.default ?? mod.plugin) as LedgerPlugin | undefined
  if (isPluginLike(plugin)) return plugin
  // 兜底：唯一的 plugin 形状导出
  const candidate = Object.values(mod).find(isPluginLike)
  if (candidate) return candidate
  throw new AppError('PLUGIN_LOAD_FAILED', `${entryUrl} does not export a LedgerPlugin (default or named "plugin")`)
}
