import type { Logger } from '@ledger/plugin-contract'

interface Watcher {
  cb: () => void
  owner?: string
}

/**
 * 轻量插件间服务模型：manifest 声明 provides/consumes，拓扑排序加载，
 * consumes 一律可选降级，服务随提供者停用自动注销，无版本协商。
 */
export class ServiceRegistry {
  private services = new Map<string, { service: unknown; owner: string }>()
  private watchers = new Map<string, Set<Watcher>>()

  constructor(private log: Logger = { debug() {}, info() {}, warn() {}, error() {} }) {}

  provide(name: string, service: unknown, owner: string): void {
    this.services.set(name, { service, owner })
    for (const w of this.watchers.get(name) ?? []) {
      try {
        w.cb()
      } catch (e) {
        this.log.error(`service watcher error on "${name}"`, e)
      }
    }
  }

  get<T>(name: string): T | undefined {
    return this.services.get(name)?.service as T | undefined
  }

  onAvailable(name: string, cb: () => void, owner?: string): void {
    let set = this.watchers.get(name)
    if (!set) {
      set = new Set()
      this.watchers.set(name, set)
    }
    set.add({ cb, owner })
  }

  /** 提供者停用/热替换时注销其全部服务，并通知观察方（观察方重新 get 拿到 undefined 即知失效） */
  revokeOwner(owner: string): void {
    const revoked: string[] = []
    for (const [name, entry] of [...this.services]) {
      if (entry.owner === owner) {
        this.services.delete(name)
        revoked.push(name)
      }
    }
    for (const name of revoked) {
      for (const w of this.watchers.get(name) ?? []) {
        try {
          w.cb()
        } catch (e) {
          this.log.error(`service watcher error on "${name}"`, e)
        }
      }
    }
    for (const set of this.watchers.values()) {
      for (const w of [...set]) {
        if (w.owner === owner) set.delete(w)
      }
    }
  }
}
