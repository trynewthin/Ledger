import { connect } from 'node:net'
import type { DispatchRequest, DispatchResult } from '@ledger/kernel'

export interface RpcClient {
  call(req: DispatchRequest): Promise<DispatchResult>
  close(): void
}

/**
 * 本地 socket RPC 客户端（CLI ↔ host，统一调用协议 over unix socket，按行 JSON）。
 * 连不上返回 null——调用方降级冷引导（混合自动模式）。
 */
export async function tryRpcConnect(sockPath: string, timeoutMs = 400): Promise<RpcClient | null> {
  return new Promise((resolvePromise) => {
    const socket = connect(sockPath)
    const settle = (client: RpcClient | null) => {
      socket.removeListener('error', onFail)
      socket.removeListener('timeout', onFail)
      if (!client) socket.destroy()
      resolvePromise(client)
    }
    const onFail = () => settle(null)
    socket.setTimeout(timeoutMs)
    socket.once('error', onFail)
    socket.once('timeout', onFail)
    socket.once('connect', () => {
      socket.setTimeout(0)
      socket.removeListener('error', onFail)
      socket.removeListener('timeout', onFail)
      let buffer = ''
      const pending = new Map<number, (r: DispatchResult) => void>()
      let nextId = 1
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line) as { id?: number; result?: DispatchResult }
            if (msg.id !== undefined && msg.result) pending.get(msg.id)?.(msg.result)
          } catch {
            // 协议噪音忽略
          }
        }
      })
      socket.on('error', () => {
        for (const r of pending.values()) r({ ok: false, error: { code: 'INTERNAL', message: 'host connection lost' } })
        pending.clear()
      })
      socket.on('close', () => {
        for (const r of pending.values()) r({ ok: false, error: { code: 'INTERNAL', message: 'host connection closed' } })
        pending.clear()
      })
      settle({
        call: (req) =>
          new Promise((res) => {
            const id = nextId++
            pending.set(id, res)
            socket.write(JSON.stringify({ id, ...req }) + '\n')
          }),
        close: () => socket.end(),
      })
    })
  })
}
