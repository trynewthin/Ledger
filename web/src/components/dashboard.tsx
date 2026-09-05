import { useTask } from "@/lib/use-task"
import { useEffect, useState } from "react"
import {
  CaretLeftIcon,
  CaretRightIcon,
  PencilSimpleIcon,
  ClockCounterClockwiseIcon,
  ProhibitIcon,
  ArrowCounterClockwiseIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { action, categoryName, money, today } from "@/lib/api"
import type { Category, Entry, History, Report } from "@/lib/api"
import { EntryForm } from "./entry-form"
import { CategorySelect, Empty, Field, Modal } from "./shared"

type Period = "day" | "week" | "month"
function iso(d: Date) {
  return d.toISOString().slice(0, 10)
}
function periodRange(anchor: string, period: Period, step = 0) {
  const d = new Date(`${anchor}T00:00:00Z`)
  if (period === "month") {
    d.setUTCDate(1)
    d.setUTCMonth(d.getUTCMonth() + step)
    return {
      from: iso(d),
      to: iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))),
    }
  }
  if (period === "week")
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  d.setUTCDate(d.getUTCDate() + step * (period === "week" ? 7 : 1))
  const from = iso(d)
  if (period === "week") d.setUTCDate(d.getUTCDate() + 6)
  return { from, to: iso(d) }
}
export function HistoryView({ id, close }: { id: string; close: () => void }) {
  const [items, setItems] = useState<History[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [error, setError] = useState("")
  const [offset, setOffset] = useState(0)
  useEffect(() => {
    let active = true
    Promise.all([
      action<History[]>("history_list", { id, offset, limit: 50 }),
      action<Category[]>("categories_list"),
    ])
      .then(([v, c]) => {
        if (active) {
          setItems(v)
          setCategories(c)
        }
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [id, offset])
  const labels: Record<string, string> = {
    amount: "金额",
    currency: "币种",
    cny_amount: "折合人民币",
    date: "日期",
    note: "备注",
    merchant: "商家",
    status: "状态",
    category_id: "分类",
    kind: "类型",
    name: "名称",
    archived: "归档",
    parent_id: "父分类",
  }
  const display = (key: string, value: unknown) => {
    if (key === "archived") return value ? "已归档" : "未归档"
    if (!value) return "—"
    if (key === "category_id" || key === "parent_id")
      return categoryName(categories, String(value))
    const names: Record<string, string> = {
      active: "有效",
      void: "已废止",
      expense: "支出",
      income: "收入",
      asset: "资产",
      liability: "负债",
    }
    return key === "kind" || key === "status"
      ? names[String(value)] || String(value)
      : String(value)
  }
  const actions: Record<string, string> = {
    entries_add: "新增记账",
    entries_batch_add: "批量记账",
    entries_update: "编辑记账",
    entries_void: "废止记账",
    entries_restore: "恢复记账",
    assets_save: "余额快照",
    categories_save: "分类调整",
  }
  return (
    <Modal title="变更历史" close={close}>
      {error && <p className="error">{error}</p>}
      <div className="history-list">
        {items.map((h) => (
          <article key={h.id}>
            <div className="row-between">
              <strong>{actions[h.action] || h.action}</strong>
              <small>{new Date(h.at).toLocaleString("zh-CN")}</small>
            </div>
            <p className="muted">
              {h.source.startsWith("web") ? "网页" : "MCP"}
              {h.reason && ` · ${h.reason}`}
            </p>
            <dl>
              {Object.entries(h.after)
                .filter(
                  ([k, v]) => labels[k] && (!h.before || h.before[k] !== v)
                )
                .map(([k, v]) => (
                  <div key={k}>
                    <dt>{labels[k]}</dt>
                    <dd>
                      {h.before && (
                        <>
                          <s>{display(k, h.before[k])}</s> →{" "}
                        </>
                      )}
                      {display(k, v)}
                    </dd>
                  </div>
                ))}
            </dl>
          </article>
        ))}
      </div>
      {!items.length && <Empty>暂无历史记录</Empty>}
      <div className="pagination">
        <Button
          variant="outline"
          disabled={!offset}
          onClick={() => setOffset(offset - 50)}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          disabled={items.length < 50}
          onClick={() => setOffset(offset + 50)}
        >
          下一页
        </Button>
      </div>
    </Modal>
  )
}
function StatusModal({
  entry,
  done,
  close,
}: {
  entry: Entry
  done: () => void
  close: () => void
}) {
  const [reason, setReason] = useState("")
  const { busy, error, run } = useTask()
  const restoring = entry.status === "void"
  return (
    <Modal title={restoring ? "恢复记账" : "废止记账"} close={close}>
      <p className="muted">
        {restoring
          ? "恢复后，这笔记录将重新计入统计。"
          : "废止后，这笔记录将退出统计，记录与历史仍会保留。"}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            await action(restoring ? "entries_restore" : "entries_void", {
              id: entry.id,
              version: entry.version,
              reason,
            })
            done()
            close()
          })
        }}
      >
        <Field label={restoring ? "恢复原因（选填）" : "废止原因"}>
          <Input
            required={!restoring}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
        </Field>
        {error && <p className="error">{error}</p>}
        <Button type="submit" disabled={busy} className="mt-5">
          {busy ? "处理中…" : restoring ? "确认恢复" : "确认废止"}
        </Button>
      </form>
    </Modal>
  )
}
export function Dashboard({
  categories,
  revision,
  refresh,
}: {
  categories: Category[]
  revision: number
  refresh: () => void
}) {
  const [period, setPeriod] = useState<Period>("month")
  const [anchor, setAnchor] = useState(today())
  const [category, setCategory] = useState("")
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("active")
  const [offset, setOffset] = useState(0)
  const [report, setReport] = useState<Report | null>(null)
  const [previous, setPrevious] = useState<Report | null>(null)
  const [items, setItems] = useState<Entry[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [edit, setEdit] = useState<Entry | null>(null)
  const [history, setHistory] = useState("")
  const [change, setChange] = useState<Entry | null>(null)
  const { from, to } = periodRange(anchor, period)
  const previousRange = periodRange(anchor, period, -1)
  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError("")
      const filters = { from, to, category_id: category, search }
      Promise.all([
        action<Report>("report", filters),
        action<Report>("report", {
          ...filters,
          from: previousRange.from,
          to: previousRange.to,
        }),
        action<{ items: Entry[]; total: number }>("entries_list", {
          ...filters,
          status,
          offset,
          limit: 20,
        }),
      ])
        .then(([r, p, l]) => {
          if (active) {
            setReport(r)
            setPrevious(p)
            setItems(l.items)
            setTotal(l.total)
          }
        })
        .catch((e) => {
          if (active) setError(e.message)
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }, 120)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [
    from,
    to,
    previousRange.from,
    previousRange.to,
    category,
    search,
    status,
    offset,
    revision,
  ])
  const changePeriod = (p: Period) => {
    setPeriod(p)
    setOffset(0)
  }
  const days: string[] = []
  for (
    const d = new Date(`${from}T00:00:00Z`);
    iso(d) <= to;
    d.setUTCDate(d.getUTCDate() + 1)
  )
    days.push(iso(d))
  const maxDaily = Math.max(1, ...Object.values(report?.daily ?? {}))
  const cats = Object.entries(report?.categories ?? {}).sort(
    (a, b) => b[1] - a[1]
  )
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">YOUR EVERYDAY LEDGER</p>
          <h1>把生活，记清楚。</h1>
          <p className="muted">从今天的一笔开始。</p>
        </div>
        <span className="today">{today().replaceAll("-", " / ")}</span>
      </div>
      <section className="panel quick-panel">
        <EntryForm categories={categories} done={refresh} />
      </section>
      <div className="section-toolbar">
        <div className="segments">
          {(["day", "week", "month"] as const).map((p, i) => (
            <button
              key={p}
              aria-pressed={period === p}
              className={period === p ? "active" : ""}
              onClick={() => changePeriod(p)}
            >
              {["日", "周", "月"][i]}
            </button>
          ))}
        </div>
        <div className="period-nav">
          <Button
            variant="ghost"
            size="icon"
            aria-label="上一期"
            onClick={() => {
              setAnchor(previousRange.from)
              setOffset(0)
            }}
          >
            <CaretLeftIcon />
          </Button>
          <span>
            {period === "month"
              ? `${from.slice(0, 4)} 年 ${Number(from.slice(5, 7))} 月`
              : from === to
                ? from
                : `${from.slice(5)} — ${to.slice(5)}`}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="下一期"
            onClick={() => {
              setAnchor(periodRange(anchor, period, 1).from)
              setOffset(0)
            }}
          >
            <CaretRightIcon />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setAnchor(today())
              setOffset(0)
            }}
          >
            今天
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="stats-grid" aria-busy={loading}>
        <section className="stat stat-main">
          <span>
            期间支出 <small>CNY</small>
          </span>
          <h2>
            <span>¥</span> {report ? money(report.expense) : "—"}
          </h2>
          <p>
            {previous && report
              ? `较上一${{ day: "日", week: "周", month: "月" }[period]}${report.expense >= previous.expense ? "增加" : "减少"} ¥${money(Math.abs(report.expense - previous.expense))}`
              : "正在读取数据"}
          </p>
        </section>
        <section className="stat">
          <span>期间收入</span>
          <h2>
            <span>¥</span> {report ? money(report.income) : "—"}
          </h2>
          <p>独立记录每一份进账</p>
        </section>
        <section className="stat">
          <span>有效记账</span>
          <h2>
            {report?.count ?? "—"} <span>笔</span>
          </h2>
          <p>废止记录不计入统计</p>
        </section>
      </div>
      {!!Object.keys(report?.pending ?? {}).length && (
        <div className="notice">
          待折算，暂未计入人民币总额：
          {Object.entries(report!.pending)
            .map(
              ([k, v]) =>
                `${k.startsWith("expense") ? "支出" : "收入"} ${k.split(":")[1]} ${money(v)}`
            )
            .join("；")}
        </div>
      )}
      <div className="charts-grid">
        <section className="panel chart-panel">
          <div className="row-between">
            <h3>支出趋势</h3>
            <small>人民币 · 元</small>
          </div>
          {report?.expense ? (
            <div className="bar-chart" role="img" aria-label="每日支出柱状图">
              {days.map((d, i) => (
                <div
                  className="bar-column"
                  key={d}
                  title={`${d}：¥${money(report.daily[d] || 0)}`}
                >
                  <div className="bar-space">
                    <div
                      className="bar"
                      style={{
                        height: `${((report.daily[d] || 0) / maxDaily) * 100}%`,
                        minHeight: report.daily[d] ? 4 : 2,
                      }}
                    />
                  </div>
                  <span>
                    {days.length <= 7 || i % 5 === 0 || i === days.length - 1
                      ? d.slice(8)
                      : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty>这一期还没有已折算的支出</Empty>
          )}
        </section>
        <section className="panel chart-panel">
          <div className="row-between">
            <h3>钱花在哪里</h3>
            <small>按类别</small>
          </div>
          {cats.length ? (
            <div className="category-bars">
              {cats.map(([id, n], i) => (
                <div key={id}>
                  <div className="row-between">
                    <span>
                      <i style={{ opacity: 1 - Math.min(i, 5) * 0.12 }} />
                      {categoryName(categories, id)}
                    </span>
                    <strong>¥{money(n)}</strong>
                  </div>
                  <div className="track">
                    <div style={{ width: `${(n / report!.expense) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>记下一笔，分布就会出现在这里</Empty>
          )}
        </section>
      </div>
      <section className="panel records-panel">
        <div className="records-header">
          <h3>
            收支明细 <span className="count">{total}</span>
          </h3>
          <div className="record-filters">
            <div className="search">
              <MagnifyingGlassIcon />
              <Input
                aria-label="搜索记账"
                placeholder="搜索商家、备注"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setOffset(0)
                }}
              />
            </div>
            <CategorySelect
              all
              categories={categories}
              value={category}
              onChange={(v) => {
                setCategory(v)
                setOffset(0)
              }}
            />
            <select
              aria-label="记录状态"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setOffset(0)
              }}
            >
              <option value="active">有效记录</option>
              <option value="void">已废止</option>
              <option value="all">全部状态</option>
            </select>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>类别 / 备注</th>
                <th>日期</th>
                <th>金额</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((v) => (
                <tr
                  key={v.id}
                  className={v.status === "void" ? "void-row" : ""}
                >
                  <td>
                    <strong>{categoryName(categories, v.category_id)}</strong>
                    {v.status === "void" && <span className="tag">已废止</span>}
                    <small>
                      {[v.merchant, v.note].filter(Boolean).join(" · ") || "—"}
                    </small>
                  </td>
                  <td>{v.date}</td>
                  <td className={v.kind === "income" ? "income" : ""}>
                    <strong>
                      {v.kind === "income" ? "+" : "−"}{" "}
                      {v.currency === "CNY" ? "¥" : v.currency} {v.amount}
                    </strong>
                    {v.currency !== "CNY" && (
                      <small>
                        {v.cny_amount ? `≈ ¥${v.cny_amount}` : "待折算"}
                      </small>
                    )}
                  </td>
                  <td>
                    <div className="table-actions">
                      {v.status === "active" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="编辑"
                          aria-label="编辑记账"
                          onClick={() => setEdit(v)}
                        >
                          <PencilSimpleIcon />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        title="历史"
                        aria-label="查看历史"
                        onClick={() => setHistory(v.id)}
                      >
                        <ClockCounterClockwiseIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={v.status === "void" ? "恢复" : "废止"}
                        aria-label={
                          v.status === "void" ? "恢复记账" : "废止记账"
                        }
                        onClick={() => setChange(v)}
                      >
                        {v.status === "void" ? (
                          <ArrowCounterClockwiseIcon />
                        ) : (
                          <ProhibitIcon />
                        )}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!items.length && (
          <Empty>{loading ? "正在读取…" : "没有符合条件的记录"}</Empty>
        )}
        <div className="pagination">
          <small>
            {total
              ? `${offset + 1}–${Math.min(offset + 20, total)} / ${total} 笔`
              : "0 笔"}
          </small>
          <Button
            variant="outline"
            size="sm"
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + 20 >= total}
            onClick={() => setOffset(offset + 20)}
          >
            下一页
          </Button>
        </div>
      </section>
      {edit && (
        <Modal title="编辑记账" close={() => setEdit(null)}>
          <EntryForm
            initial={edit}
            categories={categories}
            done={() => {
              setEdit(null)
              refresh()
            }}
          />
        </Modal>
      )}
      {history && <HistoryView id={history} close={() => setHistory("")} />}
      {change && (
        <StatusModal
          entry={change}
          close={() => setChange(null)}
          done={refresh}
        />
      )}
    </>
  )
}
