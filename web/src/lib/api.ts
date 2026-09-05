export type Category = {
  id: string
  name: string
  parent_id: string
  archived: boolean
}
export type Entry = {
  id: string
  version: number
  amount: string
  currency: string
  cny_amount: string
  kind: string
  category_id: string
  date: string
  merchant: string
  note: string
  status: string
}
export type Asset = {
  id: string
  version: number
  name: string
  kind: string
  amount: string
  currency: string
  cny_amount: string
  date: string
  note: string
  archived: boolean
}
export type History = {
  id: number
  action: string
  source: string
  reason: string
  at: string
  before: Record<string, unknown> | null
  after: Record<string, unknown>
}
export type Credential = {
  id: string
  name: string
  created: string
  last_used: string
  expires: string
  current: boolean
}
export type Report = {
  expense: number
  income: number
  count: number
  daily: Record<string, number>
  categories: Record<string, number>
  pending: Record<string, number>
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Ledger-Request": "1" },
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) {
    if (response.status === 401 && path !== "login")
      window.dispatchEvent(new Event("ledger-unauthorized"))
    throw new Error(result.error || "请求失败")
  }
  return result as T
}
export const action = <T>(op: string, body: unknown = {}) =>
  api<T>(`action/${op}`, body)
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
export const money = (cents: number) =>
  new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)
export const currencies = [
  "CNY",
  "USD",
  "EUR",
  "HKD",
  "GBP",
  "JPY",
  "AUD",
  "CAD",
  "SGD",
  "CHF",
]
export const emptyEntry = (): Entry => ({
  id: "",
  version: 0,
  amount: "",
  currency: "CNY",
  cny_amount: "",
  kind: "expense",
  category_id: "",
  date: today(),
  merchant: "",
  note: "",
  status: "active",
})
export const categoryName = (categories: Category[], id: string) => {
  const c = categories.find((c) => c.id === id)
  if (!c) return "未知分类"
  const parent = categories.find((p) => p.id === c.parent_id)
  return parent ? `${parent.name} / ${c.name}` : c.name
}
