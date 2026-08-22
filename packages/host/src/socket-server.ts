import { createServer, type Server, type Socket } from 'node:net'
import { rm } from 'node:fs/promises'
import type { RpcResult } from '@ledger/plugin-contract'

export interface SocketServerHandle {
  path: string
  close(): Promise<void>
}

interface IncomingLine {
  id?: number
  command?: string
  payload?: unknown
  context?: { source?: string; recorder?: string }
}

/**
 * 本地 socket RPC 服务：统一调用协议 over unix socket，按行 JSON。
 * CLI 的 RPC 路径与此对端（业务命令与 admin 命令同一通道）。
 */
export function startSocketServer(
  dispatch: (req: { command: string; payload?: unknown; context?: { source?: string; recorder?: string } }) => Promise<RpcResult>,
  sockPath: string,
): Promise<SocketServerHandle> {
  return new Promise((resolve, reject) => {
    let server: Server
    const sockets = new Set<Socket>()
    const handleConnection = (socket: Socket): void => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (!line.trim()) continue
          void (async () => {
            let msg: IncomingLine
            try {
              msg = JSON.parse(line) as IncomingLine
            } catch {
              socket.write(JSON.stringify({ id: null, result: { ok: false, error: { code: 'VALIDATION_ERROR', message: 'malformed JSON line' } } }) + '\n')
              return
            }
            const result = await dispatch({
              command: String(msg.command ?? ''),
              payload: msg.payload,
              context: msg.context,
            })
            socket.write(JSON.stringify({ id: msg.id ?? null, result }) + '\n')
          })()
        }
      })
    }

    void rm(sockPath, { force: true }).finally(() => {
      server = createServer(handleConnection)
      server.on('error', reject)
      server.listen(sockPath, () => {
        resolve({
          path: sockPath,
          close: async () => {
            for (const s of sockets) s.destroy()
            await new Promise<void>((res) => server.close(() => res()))
            await rm(sockPath, { force: true })
          },
        })
      })
    })
  })
}
