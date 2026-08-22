import { definePlugin, type FieldContribution, type LedgerPlugin, type TypeContribution } from '@ledger/plugin-contract'

/**
 * plugin-core-types（M6 完全体）：大/小类型层级（parentKey）+ lucide 图标 + 付款平台枚举字段。
 * 大类型 = parentKey 为 null；小类型指向大类型（direction 与父一致，由贡献数据保证）。
 * key 采用 <parent>-<leaf> 前缀命名，避免与用户运行时注册的短 key 冲突。
 */
const TYPES: TypeContribution[] = [
  // ---- 支出 · 大类型 ----
  { key: 'food', label: '餐饮', direction: 'expense', icon: 'utensils' },
  { key: 'transport', label: '交通', direction: 'expense', icon: 'car' },
  { key: 'shopping', label: '购物', direction: 'expense', icon: 'shopping-bag' },
  { key: 'housing', label: '居住', direction: 'expense', icon: 'home' },
  { key: 'entertainment', label: '娱乐', direction: 'expense', icon: 'gamepad-2' },
  { key: 'medical', label: '医疗', direction: 'expense', icon: 'heart-pulse' },
  { key: 'social', label: '人情', direction: 'expense', icon: 'heart-handshake' },
  { key: 'education', label: '教育', direction: 'expense', icon: 'graduation-cap' },
  { key: 'other-expense', label: '其他支出', direction: 'expense', icon: 'circle' },

  // ---- 支出 · 小类型 ----
  { key: 'food-coffee', label: '咖啡', direction: 'expense', parentKey: 'food', icon: 'coffee' },
  { key: 'food-takeout', label: '外卖', direction: 'expense', parentKey: 'food', icon: 'pizza' },
  { key: 'food-grocery', label: '买菜', direction: 'expense', parentKey: 'food', icon: 'shopping-basket' },
  { key: 'transport-transit', label: '公交地铁', direction: 'expense', parentKey: 'transport', icon: 'bus' },
  { key: 'transport-taxi', label: '打车', direction: 'expense', parentKey: 'transport', icon: 'car-taxi-front' },
  { key: 'transport-fuel', label: '加油', direction: 'expense', parentKey: 'transport', icon: 'fuel' },
  { key: 'shopping-clothes', label: '衣物', direction: 'expense', parentKey: 'shopping', icon: 'shirt' },
  { key: 'shopping-digital', label: '数码', direction: 'expense', parentKey: 'shopping', icon: 'smartphone' },
  { key: 'shopping-daily', label: '日用', direction: 'expense', parentKey: 'shopping', icon: 'package' },
  { key: 'housing-rent', label: '房租', direction: 'expense', parentKey: 'housing', icon: 'key-round' },
  { key: 'housing-utilities', label: '水电网', direction: 'expense', parentKey: 'housing', icon: 'plug-zap' },
  { key: 'housing-property', label: '物业', direction: 'expense', parentKey: 'housing', icon: 'building' },
  { key: 'entertainment-media', label: '影音', direction: 'expense', parentKey: 'entertainment', icon: 'clapperboard' },
  { key: 'entertainment-games', label: '游戏', direction: 'expense', parentKey: 'entertainment', icon: 'gamepad' },
  { key: 'medical-visit', label: '门诊', direction: 'expense', parentKey: 'medical', icon: 'stethoscope' },
  { key: 'medical-drug', label: '药品', direction: 'expense', parentKey: 'medical', icon: 'pill' },
  { key: 'social-gift', label: '送礼', direction: 'expense', parentKey: 'social', icon: 'gift' },
  { key: 'social-redpacket', label: '红包', direction: 'expense', parentKey: 'social', icon: 'wallet' },
  { key: 'education-books', label: '书籍', direction: 'expense', parentKey: 'education', icon: 'book-open' },
  { key: 'education-course', label: '课程', direction: 'expense', parentKey: 'education', icon: 'library' },

  // ---- 收入 ----
  { key: 'salary', label: '工资', direction: 'income', icon: 'banknote' },
  { key: 'bonus', label: '奖金', direction: 'income', icon: 'gift' },
  { key: 'investment-return', label: '投资收益', direction: 'income', icon: 'trending-up' },
  { key: 'other-income', label: '其他收入', direction: 'income', icon: 'circle' },
]

const FIELDS: FieldContribution[] = [
  {
    key: 'payment_platform',
    label: '付款平台',
    scope: 'both',
    valueType: 'enum',
    enumValues: [
      { value: 'alipay', label: '支付宝', icon: 'wallet' },
      { value: 'wechat', label: '微信', icon: 'message-circle' },
      { value: 'bank', label: '银行卡', icon: 'credit-card' },
      { value: 'cash', label: '现金', icon: 'banknote' },
    ],
  },
]

export const coreTypesPlugin: LedgerPlugin = definePlugin({
  manifest: {
    name: 'plugin-core-types',
    version: '0.2.0',
    isolation: 'inprocess',
  },
  async activate(host) {
    // 先大后小：parentKey 引用的父类型需先注册（registry 不强制，但保持数据有序）
    const parents = TYPES.filter((t) => !t.parentKey)
    const children = TYPES.filter((t) => t.parentKey)
    for (const t of [...parents, ...children]) {
      await host.registry.registerType(t)
    }
    for (const f of FIELDS) {
      await host.registry.registerField(f)
    }
  },
  async deactivate() {
    // 注册项由内核按 owner 自动反注册
  },
})
