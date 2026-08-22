import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const MCP = resolve(__dirname, '../dist/main.js')

let home: string
let proc: ReturnType<typeof spawn>
let buffer = ''
let seq = 0
const pending = new Map<number, (msg: any) => void>()

function send(msg: unknown): void {
  proc.stdin!.write(JSON.stringify(msg) + '\n')
}

/** MCP 客户端语义：请求-响应按 id 关联（stdio 按行 JSON） */
function request(method: string, params?: unknown): Promise<any> {
  const id = ++seq
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, resolvePromise)
    send({ jsonrpc: '2.0', id, method, params })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        rejectPromise(new Error(`MCP request timeout: ${method}`))
      }
    }, 15_000)
  })
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'ledger-mcp-'))
  proc = spawn('node', [MCP], { env: { ...process.env, LEDGER_HOME: home } })
  proc.stdout!.setEncoding('utf8')
  proc.stdout!.on('data', (chunk: string) => {
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
          pending.get(msg.id)!(msg)
          pending.delete(msg.id)
        }
      } catch {
        // 忽略噪音
      }
    }
  })
  proc.stderr!.on('data', () => {}) // 宿主日志不进测试输出
})

afterAll(() => {
  proc?.kill()
  rmSync(home, { recursive: true, force: true })
})

describe('plugin-mcp（冷引导 stdio）', () => {
  it('initializes with protocol handshake', { timeout: 20_000 }, async () => {
    const res = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    expect(res.result.serverInfo.name).toBe('ledger-mcp')
    expect(res.result.capabilities.tools).toBeDefined()
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  })

  it('tools/list exposes registry-driven schema (same source as CLI/WebUI)', { timeout: 20_000 }, async () => {
    // 先注册类型与枚举字段 → tool schema 应同步出现
    await request('tools/call', {
      name: 'register_field',
      arguments: {
        key: 'payment_platform', label: '付款平台', scope: 'both', valueType: 'enum',
        enumValues: [{ value: 'alipay', label: '支付宝' }, { value: 'wechat', label: '微信' }],
      },
    })

    const res = await request('tools/list')
    const tools = res.result.tools as any[]
    const names = tools.map((t) => t.name)
    expect(names).toContain('add_entry')
    expect(names).toContain('list_entries')
    expect(names).toContain('get_stats')

    const add = tools.find((t) => t.name === 'add_entry')!
    // 注册的字段出现在 schema（同源生成）
    expect(add.inputSchema.properties.payment_platform).toEqual({
      type: 'string',
      enum: ['alipay', 'wechat'],
      description: '付款平台',
    })
    expect(add.inputSchema.required).toEqual(['direction', 'amount'])
  })

  it('tools/call: add → list → stats over MCP', { timeout: 20_000 }, async () => {
    const add = await request('tools/call', {
      name: 'add_entry',
      arguments: { direction: 'expense', amount: '12.50', currency: 'CNY', payment_platform: 'alipay' },
    })
    expect(add.result.isError).toBe(false)
    const entry = JSON.parse(add.result.content[0].text)
    expect(entry.amountMinor).toBe(1250)
    expect(entry.source).toBe('mcp') // source 由调用链注入
    expect(entry.extra).toEqual({ payment_platform: 'alipay' })

    const list = await request('tools/call', { name: 'list_entries', arguments: { direction: 'expense' } })
    const data = JSON.parse(list.result.content[0].text)
    expect(data.total).toBe(1)

    const stats = await request('tools/call', { name: 'get_stats', arguments: { kind: 'summary' } })
    const summary = JSON.parse(stats.result.content[0].text)
    expect(summary.expense.CNY.totalMinor).toBe(1250)
  })

  it('error model: typed error codes surface as MCP tool errors', { timeout: 20_000 }, async () => {
    const bad = await request('tools/call', {
      name: 'add_entry',
      arguments: { direction: 'both', amount: '1' },
    })
    expect(bad.result.isError).toBe(true)
    expect(bad.result.content[0].text).toContain('VALIDATION_ERROR')

    const enumViolation = await request('tools/call', {
      name: 'add_entry',
      arguments: { direction: 'expense', amount: '1', payment_platform: 'cash' },
    })
    expect(enumViolation.result.isError).toBe(true)
    expect(enumViolation.result.content[0].text).toContain('ENUM_VIOLATION')

    const unknown = await request('tools/call', { name: 'no_such_tool', arguments: {} })
    expect(unknown.error.code).toBe(-32602)
  })
})
