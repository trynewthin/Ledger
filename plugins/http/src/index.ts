import { createServer, type Server } from 'node:http'
import {
  definePlugin,
  type CommandDescriptor,
  type HostAPI,
  type HttpCommandBinding,
  type LedgerPlugin,
  type RpcResult,
} from '@ledger/plugin-contract'

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
    case 'BOOK_NOT_FOUND':
    case 'TAG_GROUP_NOT_FOUND':
    case 'TAG_NOT_FOUND':
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
    case 'BOOK_NAME_TAKEN':
    case 'BOOK_ACTIVE':
    case 'TAG_GROUP_NAME_TAKEN':
    case 'TAG_NAME_TAKEN':
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

interface RestRoute {
  command: string
  binding: HttpCommandBinding
  segments: string[]
}

function compileRestRoutes(descriptors: CommandDescriptor[]): RestRoute[] {
  return descriptors
    .flatMap((descriptor) => descriptor.exposure?.http
      ? [{ command: descriptor.name, binding: descriptor.exposure.http, segments: pathSegments(descriptor.exposure.http.path) }]
      : [])
    // 同长度时静态路径优先，避免未来 `/entries/search` 被 `:id` 提前捕获。
    .sort((a, b) => b.segments.length - a.segments.length || staticSegments(b) - staticSegments(a))
}

async function handleRestRoute(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  routes: RestRoute[],
  host: HostAPI,
): Promise<boolean> {
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const incoming = pathSegments(url.pathname)
  const route = routes.find((candidate) => candidate.binding.method === method && routeMatches(candidate.segments, incoming))
  if (!route) return false

  let payload: Record<string, unknown> = {}
  if (method === 'GET') {
    try {
      for (const [key, kind] of Object.entries(route.binding.query ?? {})) {
        const raw = url.searchParams.get(key)
        if (raw !== null) payload[key] = parseQueryValue(raw, kind)
      }
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: error instanceof Error ? error.message : String(error) },
      })
      return true
    }
  } else {
    try {
      const raw = await readBody(req)
      payload = raw.trim() === '' ? {} : JSON.parse(raw) as Record<string, unknown>
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('body must be an object')
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'request body must be a JSON object' } })
      return true
    }
  }

  for (let index = 0; index < route.segments.length; index++) {
    const segment = route.segments[index]!
    if (segment.startsWith(':')) payload[segment.slice(1)] = decodeURIComponent(incoming[index]!)
  }

  const result = await host.dispatch({
    command: route.command,
    payload,
    context: { source: 'http', recorder: 'me' },
  })
  const status = result.ok ? route.binding.successStatus ?? 200 : statusForErrorCode(result.error.code)
  sendJson(res, status, result)
  return true
}

function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

function routeMatches(pattern: string[], incoming: string[]): boolean {
  return pattern.length === incoming.length && pattern.every((segment, index) => segment.startsWith(':') || segment === incoming[index])
}

function staticSegments(route: RestRoute): number {
  return route.segments.filter((segment) => !segment.startsWith(':')).length
}

function parseQueryValue(raw: string, kind: 'string' | 'number' | 'boolean'): string | number | boolean {
  if (kind === 'number') {
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`query value must be a number: ${raw}`)
    return value
  }
  if (kind === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    throw new Error(`query value must be true|false: ${raw}`)
  }
  return raw
}

// worker 内单实例激活，模块态即插件态（L2 每 worker 一份全新模块注册表）
let activeServer: Server | undefined

export const httpPlugin: LedgerPlugin = definePlugin({
  manifest: {
    name: 'plugin-http',
    version: '0.1.0',
    isolation: 'worker',
    config: { reads: ['plugins.plugin-http'] },
  },
  async activate(host) {
    const configuredPort = await host.config.get<number>('plugins.plugin-http.port')
    const port = Number(configuredPort ?? process.env['LEDGER_HTTP_PORT'] ?? DEFAULT_PORT)
    const catalog = await host.dispatch({ command: 'commands.describe', context: { source: 'http' } })
    if (!catalog.ok || !Array.isArray(catalog.data)) {
      throw new Error(`cannot load command capability catalog`)
    }
    const restRoutes = compileRestRoutes(catalog.data as CommandDescriptor[])
    const server = createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && (req.url === '/health' || req.url === '/api/health')) {
          sendJson(res, 200, { ok: true, plugin: 'plugin-http' })
          return
        }
        if (await handleRestRoute(req, res, restRoutes, host)) return
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
