/**
 * webui-contract — UI 插件 API 契约（前端 ABI），镜像 plugin-contract 的纪律：
 * 零依赖、纯类型 + 最小运行时，UI 插件唯一编译依赖。
 * 组件类型保持 React 无关（结构兼容即可），shell 侧负责真实渲染。
 */

export type UiComponent = (props: any) => any

export interface RegistrationOptions {
  label?: string
  order?: number
}

export interface UiHostRegistry {
  /** ui.page：路由页面（/p/<key>），label 进侧边导航 */
  registerPage(key: string, component: UiComponent, opts?: RegistrationOptions): void
  /** ui.widget：仪表盘卡片 */
  registerWidget(key: string, component: UiComponent, opts?: RegistrationOptions): void
  /** ui.panel：Entry 详情附加区块 */
  registerPanel(key: string, component: UiComponent, opts?: RegistrationOptions): void
  /** 扩展点种类按需增加（settings、command…），机制不变——不预建空扩展点 */
}

export interface LedgerClient {
  /** 统一调用协议 over HTTP；失败抛携带 code 的 Error */
  call<T = any>(command: string, payload?: unknown): Promise<T>
}

/** shell 全局状态只读切片 */
export interface UiStoreRef {
  getState(): Record<string, unknown>
}

export interface UiHostAPI {
  registry: UiHostRegistry
  client: LedgerClient
  store: UiStoreRef
}

export interface UiPluginManifest {
  name: string
  version: string
}

export interface UiPlugin {
  manifest: UiPluginManifest
  activate(host: UiHostAPI): Promise<void>
  deactivate(): Promise<void>
}

export function defineUiPlugin(plugin: UiPlugin): UiPlugin {
  return plugin
}

// ---------------------------------------------------------------------------
// 内核 DTO 镜像（结构兼容 plugin-contract；前端 ABI 自包含，零依赖）
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

export interface TypeDefDTO {
  key: string
  label: string
  direction: Direction
  parentKey: string | null
  icon: string | null
  origin: 'plugin' | 'user'
  owner: string
  enabled: boolean
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
  enumValues: FieldEnumValue[] | null
  origin: 'plugin' | 'user'
  owner: string
  enabled: boolean
  unavailable?: boolean
  registeredAt: number
}

export interface CurrencyTotal {
  count: number
  totalMinor: number
}

export type CurrencyTotals = Record<string, CurrencyTotal>

export interface StatsSummary {
  income: CurrencyTotals
  expense: CurrencyTotals
  net: Record<string, number>
}

export interface StatsMonthlyItem {
  month: string
  income: CurrencyTotals
  expense: CurrencyTotals
}

export interface StatsByTypeItem {
  type: string | null
  direction: Direction
  totals: CurrencyTotals
}
