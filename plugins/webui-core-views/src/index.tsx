import { defineUiPlugin, type UiHostAPI } from '@ledger/webui-contract'
import { AddPage } from './AddPage.js'
import { EntriesPage } from './EntriesPage.js'
import type { EntryDTO } from './types.js'

/**
 * webui-core-views — UI 插件：记账表单 / 流水列表 / Entry 详情（最小可用）。
 * 统计图表不在内，归 plugin-dataviews。
 */
export default defineUiPlugin({
  manifest: {
    name: 'webui-core-views',
    version: '0.1.0',
  },
  async activate(host: UiHostAPI) {
    host.registry.registerPage('add', (props: any) => <AddPage client={host.client} {...props} />, { label: '记一笔', order: 1 })
    host.registry.registerPage('entries', (props: any) => <EntriesPage client={host.client} {...props} />, { label: '流水', order: 2 })
    host.registry.registerPanel('entry-detail', ({ entry }: { entry: EntryDTO }) => (
      <div style={{ fontSize: 13, color: '#52525b' }}>
        {entry.type ? `类型 ${entry.type}` : '无类型'} · extra {JSON.stringify(entry.extra)}
      </div>
    ))
  },
  async deactivate() {
    // 注册项随 deactivate 自动反注册
  },
})
