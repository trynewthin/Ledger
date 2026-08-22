import { useEffect } from 'react'
import { useHashRoute } from './lib/router.js'
import { bootUiPlugins } from './ui-host/loader.js'
import { useShellStore } from './ui-host/store.js'
import { Dashboard } from './pages/Dashboard.js'
import { PluginsPage } from './pages/Plugins.js'

export function App() {
  const [route, navigate] = useHashRoute()
  const pages = useShellStore((s) => s.pages)

  useEffect(() => {
    void bootUiPlugins()
  }, [])

  let content = <Dashboard />
  if (route.startsWith('/p/')) {
    const key = route.slice(3)
    const page = pages.find((p) => p.key === key)
    content = page ? (
      <div>
        <h2 className="mb-4 text-lg font-semibold">{page.label ?? key}</h2>
        <page.component navigate={navigate} />
      </div>
    ) : (
      <div className="text-sm text-zinc-500">页面不存在或其插件未启用：{key}</div>
    )
  } else if (route === '/plugins') {
    content = <PluginsPage />
  }

  return (
    <div className="flex min-h-screen bg-zinc-50 text-zinc-900">
      <aside className="w-56 shrink-0 border-r border-zinc-200 bg-white p-4">
        <div className="mb-6 px-2 text-lg font-bold tracking-tight">Ledger</div>
        <nav className="space-y-1">
          <NavItem active={route === '/'} onClick={() => navigate('/')}>
            概览
          </NavItem>
          {pages.map((p) => (
            <NavItem key={p.key} active={route === `/p/${p.key}`} onClick={() => navigate(`/p/${p.key}`)}>
              {p.label ?? p.key}
            </NavItem>
          ))}
          <NavItem active={route === '/plugins'} onClick={() => navigate('/plugins')}>
            插件管理
          </NavItem>
        </nav>
      </aside>
      <main className="flex-1 p-6">{content}</main>
    </div>
  )
}

function NavItem({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
        active ? 'bg-zinc-100 font-medium' : 'text-zinc-600 hover:bg-zinc-50'
      }`}
    >
      {children}
    </button>
  )
}
