import { createServer, type Server } from 'node:http'
import { definePlugin, type LedgerPlugin, type RpcResult } from '@ledger/plugin-contract'

/**
 * plugin-http — L2 worker 插件：纯 API 入口（程序化访问，无 UI）。
 * 统一调用协议 over HTTP：POST /rpc { command, payload, context }。
 * L2 热更新与 supervisor 崩溃监护的首个实战载体。
 */

const DEFAULT_PORT = 7400

/** 错误模型适配：类型化错误码 → HTTP status（M4 抽出至 http-rpc 共享包） */
export function statusForErrorCode(code: string): number {
  switch (code) {
    case 'COMMAND_NOT_FOUND':
    case 'ENTRY_NOT_FOUND':
    case 'TYPE_NOT_REGISTERED':
    case 'TYPE_KEY_TAKEN':
    case 'FIELD_KEY_TAKEN':
    case 'FIELD_UNKNOWN':
    case 'PLUGIN_NOT_FOUND':
      return 404
    case 'VALIDATION_ERROR':
    case 'INVALID_AMOUNT':
    case 'INVALID_CURRENCY':
    case 'INVALID_DIRECTION':
    case 'INVALID_ENTRY':
    case 'TYPE_DIRECTION_MISMATCH':
    case 'ENUM_VIOLATION':
    case 'FIELD_TYPE_MISMATCH':
    case 'FIELD_SCOPE_MISMATCH':
      return 400
    case 'ENTRY_VOIDED':
      return 409
    case 'FORBIDDEN':
      return 403
    case 'NOT_SUPPORTED':
      return 501
    default:
      return 500
  }
}

function readBody(req: import('node:http').IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(data)
}

// worker 内单实例激活，模块态即插件态（L2 每 worker 一份全新模块注册表）
let activeServer: Server | undefined

export const httpPlugin: LedgerPlugin = definePlugin({
  manifest: {
    name: 'plugin-http',
    version: '0.1.0',
    isolation: 'worker',
  },
  async activate(host) {
    const port = Number(process.env['LEDGER_HTTP_PORT'] ?? DEFAULT_PORT)
    const server = createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && (req.url === '/health' || req.url === '/api/health')) {
          sendJson(res, 200, { ok: true, plugin: 'plugin-http' })
          return
        }
        if (req.method === 'POST' && (req.url === '/rpc' || req.url === '/api/rpc')) {
          const raw = await readBody(req)
          let parsed: { command?: string; payload?: unknown; context?: { source?: string; recorder?: string } }
          try {
            parsed = JSON.parse(raw) as typeof parsed
          } catch {
            sendJson(res, 400, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'request body must be JSON' } })
            return
          }
          if (typeof parsed.command !== 'string' || parsed.command.length === 0) {
            sendJson(res, 400, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'field "command" is required' } })
            return
          }
          const result: RpcResult = await host.dispatch({
            command: parsed.command,
            payload: parsed.payload,
            context: { source: parsed.context?.source ?? 'http', recorder: parsed.context?.recorder ?? 'me' },
          })
          if (result.ok) sendJson(res, 200, result)
          else sendJson(res, statusForErrorCode(result.error.code), result)
          return
        }
        sendJson(res, 404, { ok: false, error: { code: 'COMMAND_NOT_FOUND', message: `no route: ${req.method} ${req.url}` } })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } })
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
    activeServer = server
    host.log.info(`plugin-http listening on http://127.0.0.1:${port}`)
  },

  async deactivate() {
    const server = activeServer
    activeServer = undefined
    if (!server) return
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  },
})
