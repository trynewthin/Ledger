import type { Logger } from '@ledger/plugin-contract'

export type EventHandler = (payload: unknown) => void
interface Subscription {
  fn: EventHandler
  owner?: string
}

/** 进程内同步发布订阅；订阅随插件停用自动退订（unsubscribeOwner） */
export class EventBus {
  private handlers = new Map<string, Set<Subscription>>()

  constructor(private log: Logger = { debug() {}, info() {}, warn() {}, error() {} }) {}

  emit(event: string, payload: unknown): void {
    const subs = this.handlers.get(event)
    if (!subs) return
    for (const sub of [...subs]) {
      try {
        sub.fn(payload)
      } catch (e) {
        this.log.error(`event handler error on "${event}"`, e)
      }
    }
  }

  subscribe(event: string, fn: EventHandler, owner?: string): () => void {
    let subs = this.handlers.get(event)
    if (!subs) {
      subs = new Set()
      this.handlers.set(event, subs)
    }
    const sub: Subscription = { fn, owner }
    subs.add(sub)
    return () => subs!.delete(sub)
  }

  unsubscribeOwner(owner: string): void {
    for (const subs of this.handlers.values()) {
      for (const sub of [...subs]) {
        if (sub.owner === owner) subs.delete(sub)
      }
    }
  }

  subscriberCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0
  }
}
