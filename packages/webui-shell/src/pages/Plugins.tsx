import { useEffect, useState } from 'react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '../components/ui.js'
import { client } from '../lib/client.js'
import { bootUiPlugins, reloadPlugin, togglePlugin } from '../ui-host/loader.js'
import { useShellStore } from '../ui-host/store.js'

/** 插件管理（shell 自有视图，零业务；空 shell 亦可用） */
export function PluginsPage() {
  const plugins = useShellStore((s) => s.plugins)
  const patch = useShellStore((s) => s.patchPlugin)
  const [kernelPlugins, setKernelPlugins] = useState<any[]>([])

  useEffect(() => {
    void bootUiPlugins()
    client
      .call('plugin.list')
      .then(setKernelPlugins)
      .catch(() => setKernelPlugins([]))
  }, [])

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">UI 插件</h2>
      <p className="text-sm text-zinc-500">UI 插件在浏览器内动态加载，可启停、可热替换（失败保留旧版继续运行）。</p>
      {plugins.length === 0 && (
        <Card>
          <CardContent className="pt-6 text-sm text-zinc-500">暂无已安装的 UI 插件。空 shell 下系统依然自洽运行。</CardContent>
        </Card>
      )}
      {plugins.map((p) => (
        <Card key={p.name}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{p.name}</CardTitle>
              <Badge tone={p.active ? 'success' : 'default'}>{p.active ? '运行中' : '已停用'}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-sm text-zinc-500">版本 {p.version}</div>
            {p.error && <div className="text-sm text-red-600">{p.error}</div>}
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => void togglePlugin(p.name, !p.active).catch((e) => patch(p.name, { error: String(e) }))}
              >
                {p.active ? '停用' : '启用'}
              </Button>
              <Button variant="ghost" onClick={() => void reloadPlugin(p.name)}>
                重新加载
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      <h3 className="mb-2 mt-6 text-sm font-semibold text-zinc-500">内核插件（宿主进程）</h3>
      <div className="overflow-hidden rounded-xl border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-zinc-500">
            <tr>
              <th className="p-2">名称</th>
              <th className="p-2">版本</th>
              <th className="p-2">隔离</th>
              <th className="p-2">状态</th>
            </tr>
          </thead>
          <tbody>
            {kernelPlugins.map((p) => (
              <tr key={p.name} className="border-t border-zinc-100">
                <td className="p-2 font-mono text-xs">{p.name}</td>
                <td className="p-2">{p.version}</td>
                <td className="p-2">{p.isolation}</td>
                <td className="p-2">{p.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
