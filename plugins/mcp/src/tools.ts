import type { FieldDefDTO, TypeDefDTO } from '@ledger/plugin-contract'
import type { Kernel } from '@ledger/kernel'
import { parseDecimalToMinor } from '@ledger/domain'

/**
 * MCP tool 定义：inputSchema 与 CLI flag 生成、WebUI 表单渲染同源——
 * 都来自 type_defs / field_defs 注册表。注册一个新字段，全部入口同时获得支持。
 */

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>, kernel: Kernel) => Promise<unknown>
}

function fieldToSchema(f: FieldDefDTO): Record<string, unknown> {
  switch (f.valueType) {
    case 'enum':
      return { type: 'string', enum: (f.enumValues ?? []).map((v) => v.value), description: f.label }
    case 'number':
      return { type: 'number', description: f.label }
    case 'boolean':
      return { type: 'boolean', description: f.label }
    case 'date':
      return { type: 'string', format: 'date', description: f.label }
    default:
      return { type: 'string', description: f.label }
  }
}

function parseAt(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00`).getTime()
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T'))
  if (Number.isNaN(t)) throw new Error(`无法解析时间: ${s}`)
  return t
}

function dayStart(v: string): number {
  return new Date(`${v}T00:00:00`).getTime()
}

export async function buildTools(kernel: Kernel): Promise<McpTool[]> {
  const call = async <T>(command: string, payload?: unknown): Promise<T> => {
    const res = await kernel.dispatcher.dispatch({ command, payload, context: { source: 'mcp', recorder: 'me' } })
    if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code })
    return res.data as T
  }

  const types = await call<TypeDefDTO[]>('type.list', {}).catch(() => [] as TypeDefDTO[])
  const fields = await call<FieldDefDTO[]>('field.list', {}).catch(() => [] as FieldDefDTO[])
  const usableTypes = types.filter((t) => !t.unavailable)
  const usableFields = fields.filter((f) => !f.unavailable)

  const addEntry: McpTool = {
    name: 'add_entry',
    description: '记一笔账。type 与扩展字段来自注册表（同 CLI flag / WebUI 表单）。',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['income', 'expense'], description: '方向' },
        amount: { type: 'string', description: '十进制金额，如 "12.50"（按货币精度转为最小单位）' },
        currency: { type: 'string', description: 'ISO 4217，默认 CNY', default: 'CNY' },
        type: { type: 'string', enum: usableTypes.map((t) => t.key), description: '类型 key（可空）' },
        occurredAt: { type: 'string', description: '业务时间：YYYY-MM-DD / YYYY-MM-DD HH:mm / ISO（可空）' },
        strictExtra: { type: 'boolean', description: '严格模式：拒绝未注册扩展字段', default: false },
        ...Object.fromEntries(usableFields.map((f) => [f.key, fieldToSchema(f)])),
      },
      required: ['direction', 'amount'],
    },
    handler: async (args, k) => {
      const currency = String(args['currency'] ?? 'CNY').toUpperCase()
      const extra: Record<string, unknown> = {}
      for (const f of usableFields) {
        const v = args[f.key]
        if (v !== undefined) extra[f.key] = v
      }
      const payload: Record<string, unknown> = {
        direction: args['direction'],
        amountMinor: parseDecimalToMinor(String(args['amount']), currency),
        currency,
        type: (args['type'] as string | undefined) ?? null,
        extra,
      }
      const occurredAt = parseAt(args['occurredAt'])
      if (occurredAt !== undefined) payload['occurredAt'] = occurredAt
      if (args['strictExtra'] === true) payload['strictExtra'] = true
      return k.dispatcher.dispatch({ command: 'entry.add', payload, context: { source: 'mcp', recorder: 'me' } })
    },
  }

  const listEntries: McpTool = {
    name: 'list_entries',
    description: '查询流水（按方向/类型/日期范围过滤）',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['income', 'expense'] },
        type: { type: 'string' },
        from: { type: 'string', description: '起始日 YYYY-MM-DD' },
        to: { type: 'string', description: '结束日 YYYY-MM-DD' },
        limit: { type: 'number' },
      },
    },
    handler: async (args, k) => {
      const filter: Record<string, unknown> = {}
      if (args['direction']) filter['direction'] = args['direction']
      if (args['type'] !== undefined) filter['type'] = args['type']
      if (args['from']) filter['from'] = dayStart(String(args['from']))
      if (args['to']) filter['to'] = dayStart(String(args['to'])) + 86_399_999
      if (args['limit']) filter['limit'] = args['limit']
      return k.dispatcher.dispatch({ command: 'entry.list', payload: filter, context: { source: 'mcp' } })
    },
  }

  const reviseEntry: McpTool = {
    name: 'revise_entry',
    description: '修订一条账目（前像自动留痕）',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        amount: { type: 'string' },
        type: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['id'],
    },
    handler: async (args, k) => {
      const patch: Record<string, unknown> = {}
      if (args['amount'] !== undefined) patch['amountMinor'] = parseDecimalToMinor(String(args['amount']), 'CNY')
      if (args['type'] !== undefined) patch['type'] = args['type']
      return k.dispatcher.dispatch({
        command: 'entry.revise',
        payload: { id: args['id'], patch, reason: (args['reason'] as string | undefined) ?? null },
        context: { source: 'mcp' },
      })
    },
  }

  const voidEntry: McpTool = {
    name: 'void_entry',
    description: '作废一条账目（软删，可追溯）',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, reason: { type: 'string' } },
      required: ['id', 'reason'],
    },
    handler: async (args, k) =>
      k.dispatcher.dispatch({ command: 'entry.void', payload: { id: args['id'], reason: args['reason'] }, context: { source: 'mcp' } }),
  }

  const getStats: McpTool = {
    name: 'get_stats',
    description: '统计：summary / monthly / byType / byDirection / byRecorder',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['summary', 'monthly', 'byType', 'byDirection', 'byRecorder'] } },
      required: ['kind'],
    },
    handler: async (args, k) =>
      k.dispatcher.dispatch({ command: `stats.${args['kind']}`, payload: {}, context: { source: 'mcp' } }),
  }

  const registerField: McpTool = {
    name: 'register_field',
    description: '注册动态字段（运行时扩充，与插件贡献同表）',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '小写 slug' },
        label: { type: 'string' },
        scope: { type: 'string', enum: ['expense', 'income', 'both'] },
        valueType: { type: 'string', enum: ['string', 'number', 'enum', 'date', 'boolean'] },
        enumValues: { type: 'array', items: { type: 'object' }, description: 'enum 时必填: [{value,label}]' },
      },
      required: ['key', 'label', 'scope', 'valueType'],
    },
    handler: async (args, k) =>
      k.dispatcher.dispatch({ command: 'field.register', payload: args, context: { source: 'mcp' } }),
  }

  const listTypes: McpTool = {
    name: 'list_types',
    description: '列出已注册类型',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, k) => k.dispatcher.dispatch({ command: 'type.list', payload: {}, context: { source: 'mcp' } }),
  }

  const listFields: McpTool = {
    name: 'list_fields',
    description: '列出已注册动态字段',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, k) => k.dispatcher.dispatch({ command: 'field.list', payload: {}, context: { source: 'mcp' } }),
  }

  return [addEntry, listEntries, reviseEntry, voidEntry, getStats, registerField, listTypes, listFields]
}
