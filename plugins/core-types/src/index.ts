import { definePlugin, type LedgerPlugin, type TypeContribution } from '@ledger/plugin-contract'

/**
 * plugin-core-types（M1 基础版）：基础收支类型语义。
 * M6 升级为完全体：大/小类型层级（parentKey）+ lucide 图标 + 付款平台枚举字段。
 */
const TYPES: TypeContribution[] = [
  { key: 'food', label: '餐饮', direction: 'expense', icon: 'utensils' },
  { key: 'transport', label: '交通', direction: 'expense', icon: 'car' },
  { key: 'shopping', label: '购物', direction: 'expense', icon: 'shopping-bag' },
  { key: 'housing', label: '居住', direction: 'expense', icon: 'home' },
  { key: 'entertainment', label: '娱乐', direction: 'expense', icon: 'gamepad-2' },
  { key: 'medical', label: '医疗', direction: 'expense', icon: 'heart-pulse' },
  { key: 'other-expense', label: '其他支出', direction: 'expense', icon: 'circle' },

  { key: 'salary', label: '工资', direction: 'income', icon: 'banknote' },
  { key: 'bonus', label: '奖金', direction: 'income', icon: 'gift' },
  { key: 'investment-return', label: '投资收益', direction: 'income', icon: 'trending-up' },
  { key: 'other-income', label: '其他收入', direction: 'income', icon: 'circle' },
]

export const coreTypesPlugin: LedgerPlugin = definePlugin({
  manifest: {
    name: 'plugin-core-types',
    version: '0.1.0',
    isolation: 'inprocess',
  },
  async activate(host) {
    for (const t of TYPES) {
      await host.registry.registerType(t)
    }
  },
  async deactivate() {
    // 注册项由内核按 owner 自动反注册
  },
})
