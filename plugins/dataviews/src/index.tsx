import { defineUiPlugin } from '@ledger/webui-contract'
import { MonthlyTrendWidget, PlatformBreakdownWidget, RecorderBreakdownWidget, TypeBreakdownWidget } from './widgets.js'

/**
 * dataviews — UI 插件：概览页数据视图。
 * 贡献 registerWidget（月度趋势 / 类型分布 / 付款平台 / 记录者），
 * 数据经统一调用协议（stats.* / entry.list），注册表同源；纯 div/CSS 条形，不引图表库。
 */
export default defineUiPlugin({
  manifest: {
    name: 'dataviews',
    version: '0.1.0',
  },
  async activate(host) {
    host.registry.registerWidget('monthly-trend', () => <MonthlyTrendWidget client={host.client} />, { label: '月度趋势', order: 1 })
    host.registry.registerWidget('type-breakdown', () => <TypeBreakdownWidget client={host.client} />, { label: '类型分布', order: 2 })
    host.registry.registerWidget('platform-breakdown', () => <PlatformBreakdownWidget client={host.client} />, { label: '付款平台', order: 3 })
    host.registry.registerWidget('recorder-breakdown', () => <RecorderBreakdownWidget client={host.client} />, { label: '记录者', order: 4 })
  },
  async deactivate() {
    // 注册项随 deactivate 自动反注册（shell 侧按 owner 清理）
  },
})
