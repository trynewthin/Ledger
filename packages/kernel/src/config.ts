import { readFile, watch, type FSWatcher } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ConfigStatus, ConfigValue } from '@ledger/plugin-contract'

export const PROJECT_CONFIG_FILE = 'ledger.config.json'

type ConfigObject = Record<string, ConfigValue>
type ConfigHandler = (next: ConfigValue | undefined, previous: ConfigValue | undefined) => void

interface Subscription {
  handler: ConfigHandler
  owner?: string
}

export interface ProjectConfigOptions {
  projectRoot: string
  watch?: boolean
  /** 入口层覆盖用于测试和一次性运行；合并后插件看到的仍是同一有效快照。 */
  overrides?: ConfigObject
  debounceMs?: number
}

const DEFAULT_CONFIG: ConfigObject = {
  storage: { dataDir: '~/.ledger' },
  plugins: {},
}

/**
 * 与业务无关的配置事实源。它只负责读取、解析、合并、路径规范化和发布变更；
 * 消费方如何响应配置变化，由消费方自己决定。
 */
export class ProjectConfigStore {
  readonly projectRoot: string
  readonly filePath: string
  private current: ConfigObject = deepFreeze(clone(DEFAULT_CONFIG))
  private subscriptions = new Map<string, Set<Subscription>>()
  private watcher?: FSWatcher
  private debounce?: ReturnType<typeof setTimeout>
  private overrides: ConfigObject
  private debounceMs: number
  private initialized = false
  private state: ConfigStatus = {
    filePath: '',
    loadedAt: 0,
    restartRequired: false,
    restartRequiredPaths: [],
  }

  private constructor(options: ProjectConfigOptions) {
    this.projectRoot = resolve(options.projectRoot)
    this.filePath = join(this.projectRoot, PROJECT_CONFIG_FILE)
    this.overrides = options.overrides ?? {}
    this.debounceMs = options.debounceMs ?? 80
    this.state.filePath = this.filePath
  }

  static async open(options: ProjectConfigOptions): Promise<ProjectConfigStore> {
    const store = new ProjectConfigStore(options)
    await store.reload()
    if (options.watch) store.startWatching()
    return store
  }

  get<T extends ConfigValue = ConfigValue>(path: string): T | undefined {
    return valueAt(this.current, path) as T | undefined
  }

  require<T extends ConfigValue = ConfigValue>(path: string): T {
    const value = this.get<T>(path)
    if (value === undefined) throw new Error(`required config is missing: ${path}`)
    return value
  }

  snapshot(): Readonly<ConfigObject> {
    return this.current
  }

  status(): ConfigStatus {
    return { ...this.state, restartRequiredPaths: [...this.state.restartRequiredPaths] }
  }

  subscribe(path: string, handler: ConfigHandler, owner?: string): void {
    let set = this.subscriptions.get(path)
    if (!set) {
      set = new Set()
      this.subscriptions.set(path, set)
    }
    set.add({ handler, owner })
  }

  unsubscribeOwner(owner: string): void {
    for (const set of this.subscriptions.values()) {
      for (const subscription of [...set]) {
        if (subscription.owner === owner) set.delete(subscription)
      }
    }
  }

  async reload(): Promise<void> {
    let fileConfig: ConfigObject = {}
    try {
      const raw = await new Promise<string>((resolvePromise, rejectPromise) => {
        readFile(this.filePath, 'utf8', (error, data) => {
          if (error) rejectPromise(error)
          else resolvePromise(data)
        })
      })
      try {
        fileConfig = JSON.parse(raw) as ConfigObject
      } catch (error) {
        throw new Error(`invalid config JSON in ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.state = { ...this.state, lastError: error instanceof Error ? error.message : String(error) }
        throw error
      }
    }

    try {
      validateConfig(fileConfig)
      validateConfig(this.overrides)
      const next = deepFreeze(normalizeConfig(deepMerge(deepMerge(clone(DEFAULT_CONFIG), fileConfig), this.overrides), this.projectRoot))
      const previous = this.current
      const changedPaths = collectChangedPaths(previous, next)
      const restartPaths = this.initialized ? changedPaths.filter((path) => path === 'storage.dataDir') : []
      this.current = next
      this.state = {
        filePath: this.filePath,
        loadedAt: Date.now(),
        restartRequired: this.state.restartRequired || restartPaths.length > 0,
        restartRequiredPaths: [...new Set([...this.state.restartRequiredPaths, ...restartPaths])],
      }
      this.initialized = true
      this.publish(previous, next, changedPaths)
    } catch (error) {
      this.state = { ...this.state, lastError: error instanceof Error ? error.message : String(error) }
      throw error
    }
  }

  private startWatching(): void {
    // 监听父目录而不是文件本身，兼容编辑器“写临时文件后原子替换”的保存方式。
    this.watcher = watch(dirname(this.filePath), (_event, filename) => {
      if (filename && String(filename) !== PROJECT_CONFIG_FILE) return
      if (this.debounce) clearTimeout(this.debounce)
      this.debounce = setTimeout(() => {
        void this.reload().catch(() => {
          // lastError 已保存在状态中；保留上一份有效快照继续服务。
        })
      }, this.debounceMs)
    })
  }

  private publish(previous: ConfigObject, next: ConfigObject, changedPaths: string[]): void {
    for (const [path, subscriptions] of this.subscriptions) {
      if (!changedPaths.some((changed) => pathsOverlap(path, changed))) continue
      const before = valueAt(previous, path)
      const after = valueAt(next, path)
      for (const { handler } of subscriptions) {
        try {
          handler(after, before)
        } catch {
          // 一个消费者的回调不能阻断配置快照发布给其他消费者。
        }
      }
    }
  }

  async close(): Promise<void> {
    if (this.debounce) clearTimeout(this.debounce)
    this.watcher?.close()
    this.subscriptions.clear()
  }
}

/** 从任意仓库子目录向上发现 Ledger 根目录，避免把配置位置绑定到启动 cwd。 */
export async function findProjectRoot(startDir: string = process.cwd()): Promise<string> {
  let cursor = resolve(startDir)
  for (;;) {
    try {
      await access(join(cursor, 'pnpm-workspace.yaml'))
      return cursor
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) return resolve(startDir)
      cursor = parent
    }
  }
}

/** 所有进程入口共用同一装配函数，确保文件配置与临时环境覆盖得到同一有效快照。 */
export async function openRuntimeConfig(options: {
  watch?: boolean
  startDir?: string
  env?: NodeJS.ProcessEnv
} = {}): Promise<ProjectConfigStore> {
  const projectRoot = await findProjectRoot(options.startDir)
  const configuredHome = (options.env ?? process.env)['LEDGER_HOME']
  return ProjectConfigStore.open({
    projectRoot,
    watch: options.watch,
    ...(configuredHome ? { overrides: { storage: { dataDir: configuredHome } } } : {}),
  })
}

function validateConfig(value: unknown): asserts value is ConfigObject {
  if (!isObject(value)) throw new Error('config root must be an object')
  if (value['storage'] !== undefined) {
    if (!isObject(value['storage'])) throw new Error('config.storage must be an object')
    const dataDir = value['storage']['dataDir']
    if (dataDir !== undefined && (typeof dataDir !== 'string' || dataDir.trim() === '')) {
      throw new Error('config.storage.dataDir must be a non-empty string')
    }
  }
  if (value['plugins'] !== undefined && !isObject(value['plugins'])) {
    throw new Error('config.plugins must be an object')
  }
}

function normalizeConfig(value: ConfigObject, projectRoot: string): ConfigObject {
  const storage = value['storage'] as ConfigObject
  const raw = String(storage['dataDir'])
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
  return { ...value, storage: { ...storage, dataDir: resolve(projectRoot, expanded) } }
}

function valueAt(root: ConfigObject, path: string): ConfigValue | undefined {
  if (path === '') return root
  let cursor: ConfigValue | undefined = root
  for (const part of path.split('.')) {
    if (!isObject(cursor)) return undefined
    cursor = cursor[part]
  }
  return cursor
}

function deepMerge(base: ConfigObject, overlay: ConfigObject): ConfigObject {
  const out: ConfigObject = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = isObject(value) && isObject(out[key])
      ? deepMerge(out[key] as ConfigObject, value)
      : clone(value)
  }
  return out
}

function collectChangedPaths(before: ConfigValue, after: ConfigValue, prefix = ''): string[] {
  if (Object.is(before, after)) return []
  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    return [...keys].flatMap((key) => collectChangedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key))
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  return [prefix]
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
}

function isObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clone<T extends ConfigValue>(value: T): T {
  return structuredClone(value)
}

function deepFreeze<T extends ConfigValue>(value: T): T {
  if (isObject(value) || Array.isArray(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) {
      if ((isObject(child) || Array.isArray(child)) && !Object.isFrozen(child)) deepFreeze(child)
    }
  }
  return value
}
