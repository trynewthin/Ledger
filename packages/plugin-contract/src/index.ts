/**
 * plugin-contract — 插件 API 契约，本系统的 ABI。
 *
 * 纪律：
 * - 不依赖仓库内任何其他包（自包含）
 * - 纯类型 + 最小运行时（definePlugin）
 * - 版本纪律高于一切：破坏性变更必须升 major
 */

// ---------------------------------------------------------------------------
// 基础 DTO（与 domain 序列化形态结构兼容）
// ---------------------------------------------------------------------------

export type Direction = 'income' | 'expense'

export interface EntryDTO {
  id: string
  bookId: string
  direction: Direction
  amountMinor: number
  currency: string
  occurredAt: number
  recordedAt: number
  source: string
  recorder: string
  type: string | null
  extra: Record<string, unknown>
  schemaVersion: number
  revision: number
  voidedAt: number | null
  voidReason: string | null
}

export interface RevisionDTO {
  id: string
  entryId: string
  /** 修改前完整 JSON 快照 */
  snapshot: string
  actor: string
  source: string
  revisedAt: number
  reason: string | null
}

export interface TypeDefDTO {
  key: string
  label: string
  direction: Direction
  /** 类型层级：小类型指向大类型，NULL = 大类型 */
  parentKey: string | null
  /** lucide 图标名 */
  icon: string | null
  origin: 'plugin' | 'user'
  /** 插件名 或 'user' */
  owner: string
  enabled: boolean
  /** 提供者插件当前未激活（崩溃/未加载）时为 true——标记而非静默消失 */
  unavailable?: boolean
  registeredAt: number
}

export interface FieldEnumValue {
  value: string
  label: string
  icon?: string
}

export interface FieldDefDTO {
  key: string
  label: string
  scope: 'expense' | 'income' | 'both'
  valueType: 'string' | 'number' | 'enum' | 'date' | 'boolean'
  /** valueType 为 enum 时必填 */
  enumValues: FieldEnumValue[] | null
  origin: 'plugin' | 'user'
  owner: string
  enabled: boolean
  unavailable?: boolean
  registeredAt: number
}

// ---------------------------------------------------------------------------
// 调用上下文与输入
// ---------------------------------------------------------------------------

export interface CallContext {
  /** 调用链身份：'cli' | 'mcp' | 'http' | 'webui' | ...，由入口注入 */
  source: string
  /** 默认 'me'，可覆盖为 'bot:<id>' */
  recorder: string
}

export interface AddEntryInput {
  direction: Direction
  /** 最小货币单位整数（分），恒正 */
  amountMinor: number
  currency: string
  type?: string | null
  /** 业务发生时间（epoch ms，允许未来值），缺省为当前时间 */
  occurredAt?: number
  extra?: Record<string, unknown>
  /** 严格模式：拒绝未注册的 extra 键 */
  strictExtra?: boolean
  bookId?: string
}

export interface ReviseEntryPatch {
  direction?: Direction
  amountMinor?: number
  currency?: string
  type?: string | null
  occurredAt?: number
  /** 整体替换 extra（明确语义，不做隐式合并） */
  extra?: Record<string, unknown>
  bookId?: string
}

export interface ReviseEntryInput {
  id: string
  patch?: ReviseEntryPatch
  reason?: string | null
  strictExtra?: boolean
}

export interface EntryFilter {
  bookId?: string
  direction?: Direction
  /** null = 显式过滤无类型条目；undefined = 不过滤 */
  type?: string | null
  recorder?: string
  /** occurredAt 范围（epoch ms） */
  from?: number
  to?: number
  includeVoided?: boolean
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// 统计结果
// ---------------------------------------------------------------------------

export interface CurrencyTotal {
  count: number
  totalMinor: number
}

/** currency -> 聚合（多币种只记录不折算） */
export type CurrencyTotals = Record<string, CurrencyTotal>

export interface StatsSummary {
  income: CurrencyTotals
  expense: CurrencyTotals
  /** currency -> 收支净额（分） */
  net: Record<string, number>
}

export interface StatsMonthlyItem {
  /** 本地时区 YYYY-MM */
  month: string
  income: CurrencyTotals
  expense: CurrencyTotals
}

export interface StatsByTypeItem {
  type: string | null
  direction: Direction
  totals: CurrencyTotals
}

export interface StatsByDirectionItem {
  direction: Direction
  totals: CurrencyTotals
}

export type StatsKind = 'summary' | 'monthly' | 'byType' | 'byDirection'

export interface StatsResults {
  summary: StatsSummary
  monthly: StatsMonthlyItem[]
  byType: StatsByTypeItem[]
  byDirection: StatsByDirectionItem[]
}

// ---------------------------------------------------------------------------
// 领域事件 payload
// ---------------------------------------------------------------------------

export interface EntryEventContext {
  source: string
  recorder: string
}

export interface EntryRecordedPayload {
  kind: 'EntryRecorded'
  entry: EntryDTO
  context: EntryEventContext
}

export interface EntryRevisedPayload {
  kind: 'EntryRevised'
  entry: EntryDTO
  before: EntryDTO
  context: EntryEventContext
}

export interface EntryVoidedPayload {
  kind: 'EntryVoided'
  entry: EntryDTO
  context: EntryEventContext
}

export type LedgerEventName = 'EntryRecorded' | 'EntryRevised' | 'EntryVoided'

// ---------------------------------------------------------------------------
// 贡献物（manifest 静态声明；activate() 动态注册是另一条路）
// ---------------------------------------------------------------------------

export interface TypeContribution {
  key: string
  label: string
  direction: Direction
  parentKey?: string | null
  icon?: string | null
  /** 附加校验（JSON Schema 片段） */
  schema?: string | null
}

export interface FieldContribution {
  key: string
  label: string
  scope: 'expense' | 'income' | 'both'
  valueType: 'string' | 'number' | 'enum' | 'date' | 'boolean'
  enumValues?: FieldEnumValue[]
}

// ---------------------------------------------------------------------------
// 能力面
// ---------------------------------------------------------------------------

export interface RegistryAPI {
  registerType(def: TypeContribution): Promise<void>
  registerField(def: FieldContribution): Promise<void>
  getType(key: string): Promise<TypeDefDTO | undefined>
  listTypes(filter?: { direction?: Direction; includeUnavailable?: boolean }): Promise<TypeDefDTO[]>
  getField(key: string): Promise<FieldDefDTO | undefined>
  listFields(filter?: { scope?: 'expense' | 'income' | 'both'; includeUnavailable?: boolean }): Promise<FieldDefDTO[]>
}

export interface EventBusAPI {
  /** 订阅随插件停用自动退订，无需手动取消 */
  subscribe(event: LedgerEventName | (string & {}), handler: (payload: never) => void): void
}

export interface LedgerAPI {
  addEntry(input: AddEntryInput, ctx?: Partial<CallContext>): Promise<EntryDTO>
  reviseEntry(input: ReviseEntryInput, ctx?: Partial<CallContext>): Promise<EntryDTO>
  voidEntry(input: { id: string; reason: string }, ctx?: Partial<CallContext>): Promise<EntryDTO>
  getEntry(id: string): Promise<EntryDTO>
  listEntries(filter?: EntryFilter): Promise<{ items: EntryDTO[]; total: number }>
  listRevisions(entryId: string): Promise<RevisionDTO[]>
  stats<K extends StatsKind>(kind: K, filter?: EntryFilter): Promise<StatsResults[K]>
}

/** 轻量插件间服务模型：无版本协商，服务名即契约 */
export interface ServicesAPI {
  provide<T>(name: string, service: T): void
  get<T>(name: string): T | undefined
  /** 服务就绪/失效时回调（消费方应在回调里重新 get） */
  onAvailable(name: string, cb: () => void): void
}

export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

export interface HostAPI {
  registry: RegistryAPI
  events: EventBusAPI
  ledger: LedgerAPI
  services: ServicesAPI
  log: Logger
  meta: { pluginName: string; dataDir: string }
}

export interface PluginInfo {
  name: string
  version: string
  isolation: 'inprocess' | 'worker'
  state: 'active' | 'inactive' | 'crashed'
  provides?: string[]
  consumes?: string[]
}

export interface PluginAdminAPI {
  list(): Promise<PluginInfo[]>
  /** 宿主内已卸载的实例或 plugins 目录下的已安装插件 */
  load(target: string): Promise<PluginInfo>
  unload(name: string): Promise<void>
  /** L1：注销→重载→重注册，失败自动回滚旧版本 */
  reload(name: string): Promise<PluginInfo>
  install(sourceDir: string, opts?: { enabled?: boolean }): Promise<PluginInfo>
  uninstall(name: string): Promise<void>
  update(name: string, sourceDir: string): Promise<PluginInfo>
}

export interface HostInfo {
  name: 'ledger-host'
  pid: number
  startedAt: number
  uptimeMs: number
  plugins: PluginInfo[]
}

export interface HostControlAPI {
  info(): Promise<HostInfo>
  shutdown(): Promise<void>
}

export interface AdminHostAPI extends HostAPI {
  plugins: PluginAdminAPI
  host: HostControlAPI
}

// ---------------------------------------------------------------------------
// 插件契约
// ---------------------------------------------------------------------------

export interface PluginManifest {
  /** 如 'plugin-core-types' */
  name: string
  version: string
  /** L1 进程内 / L2 worker（冷引导进程由入口自身决定，不声明） */
  isolation: 'inprocess' | 'worker'
  /** 声明意图；实际授权以内核白名单为准 */
  capabilities?: ('admin')[]
  provides?: string[]
  consumes?: string[]
  contributes?: {
    types?: TypeContribution[]
    fields?: FieldContribution[]
  }
}

export interface LedgerPlugin {
  manifest: PluginManifest
  activate(host: HostAPI | AdminHostAPI): Promise<void>
  deactivate(ctx: { reason: 'reload' | 'shutdown' | 'crash' }): Promise<void>
}

export function definePlugin(plugin: LedgerPlugin): LedgerPlugin {
  return plugin
}

export function isAdminHost(api: HostAPI | AdminHostAPI): api is AdminHostAPI {
  return 'plugins' in api && 'host' in api
}
