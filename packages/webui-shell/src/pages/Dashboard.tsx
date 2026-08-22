import { useShellStore } from '../ui-host/store.js'
import { Card, CardContent } from '../components/ui.js'

/** 概览：注册表中的 widget 卡片（无 widget 时空态——shell 零业务视图） */
export function Dashboard() {
  const widgets = useShellStore((s) => s.widgets)
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">概览</h2>
      {widgets.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-zinc-500">暂无小组件。安装 UI 插件（如 dataviews）后这里会出现数据视图。</CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {widgets.map((w) => (
            <Card key={w.key}>
              <CardContent className="pt-6">
                <w.component />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
