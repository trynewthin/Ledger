import { definePlugin, type LedgerPlugin } from '@ledger/plugin-contract'

/**
 * plugin-description 为每条 Entry 提供可选的纯文本描述字段。
 *
 * 字段值由内核写入 Entry.extra.description；插件只提供字段定义，
 * 因此历史描述在插件停用后仍随账目保留，且所有入口共享同一校验规则。
 */
export const descriptionPlugin: LedgerPlugin = definePlugin({
  manifest: {
    name: 'plugin-description',
    version: '0.1.0',
    isolation: 'inprocess',
  },
  async activate(host) {
    await host.registry.registerField({
      key: 'description',
      label: '描述',
      scope: 'both',
      valueType: 'string',
    })
  },
  async deactivate() {
    // 字段定义由宿主按 owner 清理；Entry.extra 中的历史描述无需迁移。
  },
})
