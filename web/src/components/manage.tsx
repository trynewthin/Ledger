import { useTask } from "@/lib/use-task"
import { useEffect, useState } from "react"
import {
  PlusIcon,
  ClockCounterClockwiseIcon,
  PencilSimpleIcon,
  CopyIcon,
  KeyIcon,
} from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { action, api, categoryName, money, today } from "@/lib/api"
import type { Asset, Category, Credential } from "@/lib/api"
import { CurrencySelect, Empty, Field, Modal } from "./shared"
import { HistoryView } from "./dashboard"

function AssetForm({
  initial,
  done,
  close,
}: {
  initial?: Asset
  done: () => void
  close: () => void
}) {
  const [asset, setAsset] = useState<Asset>(
    initial ?? {
      id: "",
      version: 0,
      name: "",
      kind: "asset",
      amount: "",
      currency: "CNY",
      cny_amount: "",
      date: today(),
      note: "",
      archived: false,
    }
  )
  const [reason, setReason] = useState("")
  const { busy, error, run } = useTask()
  const change = (key: keyof Asset, value: string | boolean) =>
    setAsset((v) => ({ ...v, [key]: value }))
  return (
    <Modal title={initial ? "更新余额快照" : "添加资产或负债"} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            await action("assets_save", { asset, reason })
            done()
            close()
          })
        }}
      >
        <div className="form-grid">
          <Field label="名称">
            <Input
              required
              value={asset.name}
              onChange={(e) => change("name", e.target.value)}
              placeholder="例如：储蓄卡"
            />
          </Field>
          <Field label="类型">
            <select
              value={asset.kind}
              onChange={(e) => change("kind", e.target.value)}
            >
              <option value="asset">资产</option>
              <option value="liability">负债</option>
            </select>
          </Field>
          <Field label="余额">
            <Input
              required
              inputMode="decimal"
              value={asset.amount}
              onChange={(e) => change("amount", e.target.value)}
            />
          </Field>
          <Field label="币种">
            <CurrencySelect
              value={asset.currency}
              onChange={(v) => change("currency", v)}
            />
          </Field>
          {asset.currency !== "CNY" && (
            <Field label="折合人民币（选填）">
              <Input
                value={asset.cny_amount}
                onChange={(e) => change("cny_amount", e.target.value)}
              />
            </Field>
          )}
          <Field label="余额日期">
            <Input
              required
              type="date"
              value={asset.date}
              onChange={(e) => change("date", e.target.value)}
            />
          </Field>
          <Field label="备注">
            <Input
              value={asset.note}
              onChange={(e) => change("note", e.target.value)}
            />
          </Field>
          {initial && (
            <>
              <Field label="调整原因">
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={asset.archived}
                  onChange={(e) => change("archived", e.target.checked)}
                />
                归档此项（退出当前汇总）
              </label>
            </>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        <Button type="submit" disabled={busy} className="mt-5">
          {busy ? "保存中…" : "保存快照"}
        </Button>
      </form>
    </Modal>
  )
}
type AssetPoint = {
  date: string
  assets: number
  liabilities: number
  net: number
  pending: number
}
export function Assets() {
  const [timeline, setTimeline] = useState<AssetPoint[]>([])
  const [items, setItems] = useState<Asset[]>([])
  const [revision, setRevision] = useState(0)
  const [edit, setEdit] = useState<Asset | "new" | null>(null)
  const [history, setHistory] = useState("")
  const [error, setError] = useState("")
  const [archived, setArchived] = useState(false)
  useEffect(() => {
    let active = true
    Promise.all([
      action<Asset[]>("assets_list"),
      action<AssetPoint[]>("assets_timeline"),
    ])
      .then(([v, points]) => {
        if (active) {
          setItems(v)
          setTimeline(points)
          setError("")
        }
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [revision])
  const totals = { asset: 0, liability: 0 }
  let pending = 0
  for (const a of items.filter((v) => !v.archived)) {
    const value = a.currency === "CNY" ? a.amount : a.cny_amount
    if (value)
      totals[a.kind as "asset" | "liability"] += Math.round(Number(value) * 100)
    else pending++
  }
  return (
    <>
      <div className="page-title">
        <div>
          <h1>资产概况</h1>
          <p className="muted">管理资产、负债与余额快照。</p>
        </div>
        <Button onClick={() => setEdit("new")}>
          <PlusIcon />
          添加资产 / 负债
        </Button>
      </div>
      <div className="stats-grid">
        <section className="stat stat-main">
          <span>净资产 · CNY</span>
          <h2>¥ {money(totals.asset - totals.liability)}</h2>
          <p>基于各项最近一次填写的余额</p>
        </section>
        <section className="stat">
          <span>总资产</span>
          <h2>¥ {money(totals.asset)}</h2>
        </section>
        <section className="stat">
          <span>总负债</span>
          <h2>¥ {money(totals.liability)}</h2>
        </section>
      </div>
      {!!pending && (
        <div className="notice">
          {pending} 项外币余额尚未折算，暂未计入汇总。
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <section className="panel asset-timeline">
        <div className="records-header">
          <h3>净资产变化</h3>
          <small>按余额日期 · 人民币</small>
        </div>
        {timeline.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>资产</th>
                  <th>负债</th>
                  <th>净资产</th>
                </tr>
              </thead>
              <tbody>
                {timeline
                  .slice(-12)
                  .reverse()
                  .map((p) => (
                    <tr key={p.date}>
                      <td>{p.date}</td>
                      <td>¥ {money(p.assets)}</td>
                      <td>¥ {money(p.liabilities)}</td>
                      <td>
                        <strong>¥ {money(p.net)}</strong>
                        {p.pending > 0 && <small>{p.pending} 项待折算</small>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>保存余额后，这里会留下净资产的变化。</Empty>
        )}
        <p className="panel-note">
          最近 12
          个有快照的日期；每个日期沿用各项目当时最新的余额，同日调整采用最后一次记录。
        </p>
      </section>
      <section className="panel">
        <div className="records-header">
          <h3>余额快照</h3>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />
            显示归档项目
          </label>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>余额</th>
                <th>更新日期</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items
                .filter((v) => archived || !v.archived)
                .map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.name}</strong>
                      {a.archived && <span className="tag">已归档</span>}
                      <small>{a.note || "—"}</small>
                    </td>
                    <td>{a.kind === "asset" ? "资产" : "负债"}</td>
                    <td>
                      <strong>
                        {a.currency} {a.amount}
                      </strong>
                      {a.currency !== "CNY" && (
                        <small>
                          {a.cny_amount ? `≈ ¥${a.cny_amount}` : "待折算"}
                        </small>
                      )}
                    </td>
                    <td>{a.date}</td>
                    <td>
                      <div className="table-actions">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="更新余额"
                          onClick={() => setEdit(a)}
                        >
                          <PencilSimpleIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="余额历史"
                          onClick={() => setHistory(a.id)}
                        >
                          <ClockCounterClockwiseIcon />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!items.length && <Empty>添加一项资产，留下第一张余额快照。</Empty>}
        <p className="panel-note">
          日常收支与资产余额独立维护。每次更新都会保留历史快照。
        </p>
      </section>
      {edit && (
        <AssetForm
          initial={edit === "new" ? undefined : edit}
          done={() => setRevision((v) => v + 1)}
          close={() => setEdit(null)}
        />
      )}
      {history && <HistoryView id={history} close={() => setHistory("")} />}
    </>
  )
}
export function Categories({
  categories,
  refresh,
}: {
  categories: Category[]
  refresh: () => void
}) {
  const [edit, setEdit] = useState<Category | null>(null)
  const { busy, error, run } = useTask()
  return (
    <>
      <div className="page-title">
        <div>
          <h1>分类管理</h1>
          <p className="muted">管理记账使用的两级分类。</p>
        </div>
        <Button
          onClick={() =>
            setEdit({ id: "", name: "", parent_id: "", archived: false })
          }
        >
          <PlusIcon />
          新增分类
        </Button>
      </div>
      <div className="category-grid">
        {categories
          .filter((c) => !c.parent_id)
          .map((p) => (
            <section className="panel" key={p.id}>
              <div className="records-header">
                <h3>
                  {p.name}
                  {p.archived && <span className="tag">已归档</span>}
                </h3>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`编辑${p.name}`}
                  onClick={() => setEdit({ ...p })}
                >
                  <PencilSimpleIcon />
                </Button>
              </div>
              <div className="category-children">
                {categories
                  .filter((c) => c.parent_id === p.id)
                  .map((c) => (
                    <button key={c.id} onClick={() => setEdit({ ...c })}>
                      {c.name}
                      {c.archived && " · 已归档"}
                      <PencilSimpleIcon size={14} />
                    </button>
                  ))}
                {!p.archived && (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setEdit({
                        id: "",
                        name: "",
                        parent_id: p.id,
                        archived: false,
                      })
                    }
                  >
                    <PlusIcon />
                    添加子分类
                  </Button>
                )}
              </div>
            </section>
          ))}
      </div>
      {edit && (
        <Modal
          title={edit.id ? "编辑分类" : "新增分类"}
          close={() => setEdit(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void run(async () => {
                await action("categories_save", { category: edit })
                refresh()
                setEdit(null)
              })
            }}
          >
            <Field label="分类名称">
              <Input
                required
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              />
            </Field>
            <Field label="所属分类">
              <select
                value={edit.parent_id}
                disabled={!!edit.id}
                onChange={(e) =>
                  setEdit({ ...edit, parent_id: e.target.value })
                }
              >
                <option value="">一级分类</option>
                {categories
                  .filter((c) => !c.parent_id && !c.archived)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {categoryName(categories, c.id)}
                    </option>
                  ))}
              </select>
            </Field>
            {edit.id && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={edit.archived}
                  onChange={(e) =>
                    setEdit({ ...edit, archived: e.target.checked })
                  }
                />
                归档分类（已有账目仍然保留）
              </label>
            )}
            {error && <p className="error">{error}</p>}
            <Button type="submit" disabled={busy} className="mt-5">
              保存分类
            </Button>
          </form>
        </Modal>
      )}
    </>
  )
}
export function Settings({ logout }: { logout: () => void }) {
  const [tokens, setTokens] = useState<Credential[]>([])
  const [sessions, setSessions] = useState<Credential[]>([])
  const [name, setName] = useState("")
  const [days, setDays] = useState(365)
  const [secret, setSecret] = useState("")
  const [revision, setRevision] = useState(0)
  const [currentPassword, setCurrentPassword] = useState("")
  const [password, setPassword] = useState("")
  const [loadError, setLoadError] = useState("")
  const [copied, setCopied] = useState(false)
  const { busy, error, run } = useTask()
  const reload = () => setRevision((v) => v + 1)
  useEffect(() => {
    let active = true
    Promise.all([api<Credential[]>("tokens"), api<Credential[]>("sessions")])
      .then(([t, s]) => {
        if (active) {
          setTokens(t)
          setSessions(s)
          setLoadError("")
        }
      })
      .catch((e) => {
        if (active) setLoadError(e.message)
      })
    return () => {
      active = false
    }
  }, [revision])
  const revoke = (id: string, current = false) =>
    void run(async () => {
      await api("revoke", { id })
      if (current) logout()
      else reload()
    })
  return (
    <>
      <div className="page-title">
        <div>
          <h1>连接与安全</h1>
          <p className="muted">管理 AI 访问与登录设备。</p>
        </div>
        <KeyIcon size={32} weight="light" />
      </div>
      {(error || loadError) && (
        <p className="error" role="alert">
          {error || loadError}
        </p>
      )}
      <section className="panel settings-panel">
        <h3>MCP 访问令牌</h3>
        <p className="muted">
          让支持 HTTP MCP 与 Bearer Token 的 AI 平台连接你的账本。
        </p>
        <div className="endpoint">
          <span>Streamable HTTP</span>
          <code>{window.location.origin}/mcp</code>
        </div>
        <p className="panel-note">
          请求头：Authorization: Bearer
          &lt;Token&gt;。令牌具有账目、分类和资产的完整操作权限。
        </p>
        <form
          className="token-form"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              const v = await api<{ token: string }>("tokens", { name, days })
              setSecret(v.token)
              setCopied(false)
              setName("")
              reload()
            })
          }}
        >
          <Input
            required
            aria-label="令牌名称"
            placeholder="令牌名称，例如：我的 AI 助手"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            aria-label="令牌有效期"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={30}>30 天</option>
            <option value={90}>90 天</option>
            <option value={365}>1 年</option>
            <option value={0}>长期有效</option>
          </select>
          <Button type="submit" disabled={busy}>
            <PlusIcon />
            创建 Token
          </Button>
        </form>
        <div className="credential-list">
          {tokens.map((t) => (
            <div key={t.id}>
              <div>
                <strong>{t.name}</strong>
                <small>
                  最近使用 {new Date(t.last_used).toLocaleString("zh-CN")} ·{" "}
                  {t.expires.startsWith("9999")
                    ? "长期有效"
                    : `到期 ${t.expires.slice(0, 10)}`}
                </small>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => revoke(t.id)}
              >
                撤销
              </Button>
            </div>
          ))}
          {!tokens.length && <Empty>还没有访问令牌</Empty>}
        </div>
      </section>
      <section className="panel settings-panel">
        <h3>登录设备</h3>
        <p className="muted">每次登录保持 90 天，可随时撤销设备会话。</p>
        <div className="credential-list">
          {sessions.map((s) => (
            <div key={s.id}>
              <div>
                <strong>{s.current ? "当前设备" : "其他设备"}</strong>
                <p className="device-name">{s.name}</p>
                <small>
                  最近活动 {new Date(s.last_used).toLocaleString("zh-CN")} ·
                  到期 {s.expires.slice(0, 10)}
                </small>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => revoke(s.id, s.current)}
              >
                {s.current ? "退出登录" : "撤销"}
              </Button>
            </div>
          ))}
        </div>
      </section>
      <section className="panel settings-panel">
        <h3>修改密码</h3>
        <p className="muted">
          修改后所有设备需要重新登录，MCP Token 保持有效。
        </p>
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              await api("password", { current: currentPassword, password })
              logout()
            })
          }}
        >
          <Field label="当前密码">
            <Input
              required
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </Field>
          <Field label="新密码（至少 12 位）">
            <Input
              required
              minLength={12}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            更新密码
          </Button>
        </form>
      </section>
      {secret && (
        <Modal title="保存你的 Token" close={() => setSecret("")}>
          <p className="muted">
            完整 Token 仅显示这一次，请保存到你的 AI 平台配置中。
          </p>
          <code className="secret">{secret}</code>
          <Button
            onClick={() =>
              void run(async () => {
                await navigator.clipboard.writeText(secret)
                setCopied(true)
              })
            }
          >
            <CopyIcon />
            {copied ? "已复制" : "复制 Token"}
          </Button>
          {error && <p className="error">{error}</p>}
        </Modal>
      )}
    </>
  )
}
