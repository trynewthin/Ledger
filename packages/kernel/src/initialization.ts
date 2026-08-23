import type { ProjectInitializationAPI } from '@ledger/plugin-contract'

interface Initializer {
  name: string
  owner: string
  initialize: () => void | Promise<void>
}

/**
 * Config Core 的项目初始化生命周期。它只协调已注册的基础设施初始化器，
 * 不理解初始化器创建的业务数据；重复运行时由各初始化器自身保证幂等。
 */
export class ProjectInitializationRegistry implements ProjectInitializationAPI {
  private initializers: Initializer[] = []
  private completed = new Set<string>()

  constructor(readonly projectRoot: string) {}

  register(name: string, initialize: () => void | Promise<void>): void
  register(name: string, owner: string, initialize: () => void | Promise<void>): void
  register(
    name: string,
    ownerOrInitialize: string | (() => void | Promise<void>),
    maybeInitialize?: () => void | Promise<void>,
  ): void {
    const owner = typeof ownerOrInitialize === 'string' ? ownerOrInitialize : 'core'
    const initialize = typeof ownerOrInitialize === 'function' ? ownerOrInitialize : maybeInitialize
    if (!name) throw new Error('project initializer name must be non-empty')
    if (!initialize) throw new Error(`project initializer ${name} is missing a handler`)
    if (this.initializers.some((item) => item.name === name)) {
      throw new Error(`project initializer already registered: ${name}`)
    }
    this.initializers.push({ name, owner, initialize })
  }

  unregisterOwner(owner: string): void {
    for (const initializer of this.initializers) {
      if (initializer.owner === owner) this.completed.delete(initializer.name)
    }
    this.initializers = this.initializers.filter((item) => item.owner !== owner)
  }

  async run(): Promise<string[]> {
    const completed: string[] = []
    for (const initializer of this.initializers) {
      if (this.completed.has(initializer.name)) continue
      await initializer.initialize()
      this.completed.add(initializer.name)
      completed.push(initializer.name)
    }
    return completed
  }
}

export const noopProjectInitialization: ProjectInitializationAPI = {
  projectRoot: '',
  register: () => {},
}
