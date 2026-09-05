import { useTask } from "@/lib/use-task"
import { useCallback, useEffect, useState } from "react"
import {
  ChartBarIcon,
  WalletIcon,
  SquaresFourIcon,
  PlugsConnectedIcon,
  SignOutIcon,
  SidebarSimpleIcon,
  ArrowRightIcon,
} from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dashboard } from "@/components/dashboard"
import { Assets, Categories, Settings } from "@/components/manage"
import { Field } from "@/components/shared"
import { action, api } from "@/lib/api"
import type { Category } from "@/lib/api"
import "./app.css"

export default function App() {
  const [user, setUser] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const [page, setPage] = useState("ledger")
  const [collapsed, setCollapsed] = useState(false)
  const [categories, setCategories] = useState<Category[]>([])
  const [revision, setRevision] = useState(0)
  const [loadError, setLoadError] = useState("")
  const refresh = useCallback(() => setRevision((v) => v + 1), [])
  useEffect(() => {
    const clear = () => {
      setUser(null)
      setCategories([])
    }
    window.addEventListener("ledger-unauthorized", clear)
    api<{ username: string }>("me")
      .then((v) => setUser(v.username))
      .catch((e) => {
        if (e.message !== "请登录") setLoadError(e.message)
      })
      .finally(() => setChecking(false))
    return () => window.removeEventListener("ledger-unauthorized", clear)
  }, [])
  useEffect(() => {
    if (!user) return
    let active = true
    action<Category[]>("categories_list")
      .then((v) => {
        if (active) {
          setCategories(v)
          setLoadError("")
        }
      })
      .catch((e) => {
        if (active) setLoadError(e.message)
      })
    return () => {
      active = false
    }
  }, [user, revision])
  if (checking) return <div className="loading-screen">正在打开账本…</div>
  if (!user) return <Login done={setUser} error={loadError} />
  const nav = [
    { id: "ledger", title: "日常账本", icon: ChartBarIcon },
    { id: "assets", title: "资产概况", icon: WalletIcon },
    { id: "categories", title: "分类管理", icon: SquaresFourIcon },
    { id: "settings", title: "连接与安全", icon: PlugsConnectedIcon },
  ]
  return (
    <div className={`app-shell${collapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault()
            setPage("ledger")
          }}
        >
          Ledger
        </a>
        <div className="sidebar-label">工作空间</div>
        <nav aria-label="主导航">
          {nav.map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "selected" : ""}
              aria-current={page === n.id ? "page" : undefined}
              onClick={() => setPage(n.id)}
            >
              <n.icon size={20} weight="regular" />
              {n.title}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile">
            <span className="avatar">{user.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{user}</strong>
              <small>个人账本</small>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="退出登录"
              onClick={() => {
                void api("logout", {})
                  .then(() => setUser(null))
                  .catch((e) => setLoadError(e.message))
              }}
            >
              <SignOutIcon />
            </Button>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="workspace-header">
          <Button
            variant="ghost"
            size="icon"
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            <SidebarSimpleIcon size={21} />
          </Button>
          <span>{nav.find((n) => n.id === page)?.title}</span>
          <span className="workspace-private">个人空间</span>
        </header>
        <main>
          {loadError && (
            <p className="error">
              {loadError}
              <button onClick={refresh}>重试</button>
            </p>
          )}
          {page === "ledger" && (
            <Dashboard
              categories={categories}
              revision={revision}
              refresh={refresh}
            />
          )}
          {page === "assets" && <Assets />}
          {page === "categories" && (
            <Categories categories={categories} refresh={refresh} />
          )}
          {page === "settings" && <Settings logout={() => setUser(null)} />}
        </main>
      </div>
    </div>
  )
}
function Login({
  done,
  error: externalError,
}: {
  done: (name: string) => void
  error: string
}) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const { busy, error, run } = useTask()
  return (
    <div className="login-page">
      <div className="login-brand">Ledger</div>
      <div className="login-form-wrap">
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              await api("login", { username, password })
              done(username)
            })
          }}
        >
          <h2>登录 Ledger</h2>
          <p className="muted">登录你的个人财务空间。</p>
          <Field label="账号">
            <Input
              required
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="密码">
            <Input
              required
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {(error || externalError) && (
            <p className="error" role="alert">
              {error || externalError}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? "登录中…" : "登录"}
            <ArrowRightIcon />
          </Button>
          <small>在此设备保持登录 90 天</small>
        </form>
      </div>
    </div>
  )
}
