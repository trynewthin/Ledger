import type {
  ConfigStatus,
  ConfigValue,
  StorageArtifact,
  StorageEntry,
  StorageImportPlan,
  StorageImportResult,
  StorageValue,
} from '@ledger/plugin-contract'

export interface ConfigProvider {
  get<T extends ConfigValue = ConfigValue>(path: string): T | undefined
  require<T extends ConfigValue = ConfigValue>(path: string): T
  snapshot(): Readonly<Record<string, ConfigValue>>
  status(): ConfigStatus
  subscribe(
    path: string,
    handler: (next: ConfigValue | undefined, previous: ConfigValue | undefined) => void,
    owner?: string,
  ): void
  unsubscribeOwner(owner: string): void
  close?(): Promise<void> | void
}

export interface StorageProvider {
  get<T extends StorageValue = StorageValue>(owner: string, key: string): T | undefined
  set<T extends StorageValue = StorageValue>(owner: string, key: string, value: T): void
  delete(owner: string, key: string): void
  list<T extends StorageValue = StorageValue>(owner: string, prefix?: string): StorageEntry<T>[]
  exportAll(options: { destination: string }): Promise<StorageArtifact>
  inspectImport(source: string): Promise<StorageImportPlan>
  importAll(source: string, options?: { createSafetyBackup?: boolean }): Promise<StorageImportResult>
}

const EMPTY_CONFIG: Readonly<Record<string, ConfigValue>> = Object.freeze({})

export const noopConfigProvider: ConfigProvider = {
  get: () => undefined,
  require: (path) => { throw new Error(`required config is missing: ${path}`) },
  snapshot: () => EMPTY_CONFIG,
  status: () => ({ filePath: '', loadedAt: 0, restartRequired: false, restartRequiredPaths: [] }),
  subscribe: () => {},
  unsubscribeOwner: () => {},
  close: () => {},
}

export const noopStorageProvider: StorageProvider = {
  get: () => undefined,
  set: () => { throw new Error('storage core is not available in this assembly') },
  delete: () => {},
  list: () => [],
  exportAll: async () => { throw new Error('storage core is not available in this assembly') },
  inspectImport: async (source) => ({
    source,
    format: 'sqlite-native',
    formatVersion: 1,
    compatible: false,
    tables: [],
    warnings: ['storage core is not available in this assembly'],
  }),
  importAll: async () => { throw new Error('storage core is not available in this assembly') },
}
