import { createInterface } from 'node:readline'
import type { ConfigProvider, Kernel } from '@ledger/kernel'
import { assembleColdKernel } from '@ledger/plugin-cli'
import { buildTools, type McpTool } from './tools.js'

/**
 * plugin-mcp — 冷引导独立进程：被 MCP 客户端 spawn，stdio 通信（JSON-RPC 2.0，
 * 按行 JSON）。像 CLI 一样组装内核：加载 → 执行 → 退出；热更新 = 进程重启。
 */

const PROTOCOL_VERSION = '2025-06-18'

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

function write(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id: number | string | null, result: unknown): void {
  write({ jsonrpc: '2.0', id, result })
}

function replyError(id: number | string | null, code: number, message: string): void {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

export async function runMcpServer(opts: { home: string; configProvider?: ConfigProvider }): Promise<void> {
  const boot = await assembleColdKernel(opts.home, opts.configProvider)
  const kernel: Kernel = boot.kernel

  // 同源原则：tool schema 每次即时从注册表构建（注册新字段立即反映）
  let tools: McpTool[] = await buildTools(kernel)
  const toolsByName = (): Map<string, McpTool> => new Map(tools.map((t) => [t.name, t]))

  const handle = async (msg: JsonRpcMessage): Promise<void> => {
    const { id = null, method } = msg
    if (method === undefined) return

    if (method === 'initialize') {
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ledger-mcp', version: '0.1.0' },
        instructions: '个人记账系统：add_entry 记账、list_entries 查询、get_stats 统计。类型与字段来自注册表。',
      })
      return
    }
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) return
    if (method === 'ping') {
      reply(id, {})
      return
    }
    if (method === 'tools/list') {
      tools = await buildTools(kernel)
      reply(id, {
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      })
      return
    }
    if (method === 'tools/call') {
      const params = msg.params as { name?: string; arguments?: Record<string, unknown> } | undefined
      tools = await buildTools(kernel)
      const tool = params?.name !== undefined ? toolsByName().get(params.name) : undefined
      if (!tool) {
        replyError(id, -32602, `unknown tool: ${String(params?.name)}`)
        return
      }
      try {
        const result = await tool.handler(params?.arguments ?? {}, kernel)
        const envelope = result as { ok: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } }
        if (envelope && envelope.ok === false) {
          // 错误模型贯穿：类型化错误码 → MCP tool error
          const err = envelope.error ?? { code: 'INTERNAL', message: 'unknown error' }
          reply(id, {
            content: [{ type: 'text', text: `[${err.code}] ${err.message}` }],
            isError: true,
          })
          return
        }
        reply(id, {
          content: [{ type: 'text', text: JSON.stringify(envelope.data ?? null, null, 2) }],
          isError: false,
        })
      } catch (e) {
        reply(id, {
          content: [{ type: 'text', text: `[${(e as { code?: string }).code ?? 'INTERNAL'}] ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        })
      }
      return
    }
    replyError(id, -32601, `method not found: ${method}`)
  }

  const rl = createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (line) => {
    if (!line.trim()) return
    try {
      const msg = JSON.parse(line) as JsonRpcMessage
      void handle(msg)
    } catch {
      replyError(null, -32700, 'parse error')
    }
  })
  await new Promise<void>((resolve) => rl.on('close', () => resolve()))
  boot.close()
  await opts.configProvider?.close?.()
}
