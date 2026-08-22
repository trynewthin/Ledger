/**
 * http-rpc — 统一调用协议的 HTTP 编码/解码（非内核，纯工具包）。
 * plugin-http / plugin-webui 共用：{ command, payload, context } over HTTP。
 */

export interface RpcRequestBody {
  command?: string
  payload?: unknown
  context?: { source?: string; recorder?: string }
}

export type RpcResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

export type DispatchFn = (req: {
  command: string
  payload?: unknown
  context?: { source?: string; recorder?: string }
}) => Promise<RpcResult>

/** 错误模型适配：类型化错误码 → HTTP status */
export function statusForErrorCode(code: string): number {
  switch (code) {
    case 'COMMAND_NOT_FOUND':
    case 'ENTRY_NOT_FOUND':
    case 'TYPE_NOT_REGISTERED':
    case 'TYPE_KEY_TAKEN':
    case 'FIELD_KEY_TAKEN':
    case 'FIELD_UNKNOWN':
    case 'PLUGIN_NOT_FOUND':
    case 'USER_NOT_FOUND':
    case 'SNAPSHOT_NOT_FOUND':
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
    case 'SERVICE_UNAVAILABLE':
      return 503
    case 'FORBIDDEN':
      return 403
    case 'NOT_SUPPORTED':
      return 501
    default:
      return 500
  }
}

export function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(data)
}

export function readBody(req: import('node:http').IncomingMessage, limitBytes = 1_000_000): Promise<string> {
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

/**
 * 处理统一调用协议的 HTTP 请求（POST /rpc 或 /api/rpc）。
 * 返回 true 表示已处理；调用方继续处理其他路由。
 */
export async function handleRpcRoute(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  dispatch: DispatchFn,
  opts?: { defaultSource?: string },
): Promise<boolean> {
  if (req.method !== 'POST' || !(req.url === '/rpc' || req.url === '/api/rpc')) return false
  let parsed: RpcRequestBody
  try {
    parsed = JSON.parse(await readBody(req)) as RpcRequestBody
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'request body must be JSON' } })
    return true
  }
  if (typeof parsed.command !== 'string' || parsed.command.length === 0) {
    sendJson(res, 400, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'field "command" is required' } })
    return true
  }
  const source = parsed.context?.source ?? opts?.defaultSource ?? 'http'
  const result = await dispatch({
    command: parsed.command,
    payload: parsed.payload,
    context: { source, recorder: parsed.context?.recorder ?? 'me' },
  })
  sendJson(res, result.ok ? 200 : statusForErrorCode(result.error.code), result)
  return true
}
