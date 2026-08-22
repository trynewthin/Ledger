import type { LedgerClient } from '@ledger/webui-contract'

/** 内核 client：统一调用协议 over HTTP，与 CLI/MCP/HTTP 一视同仁，无特权通道 */
export const client: LedgerClient = {
  async call<T = any>(command: string, payload?: unknown): Promise<T> {
    const res = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command, payload, context: { source: 'webui', recorder: 'me' } }),
    })
    const body = (await res.json()) as { ok: boolean; data?: T; error?: { code: string; message: string } }
    if (!body.ok) {
      throw Object.assign(new Error(body.error?.message ?? 'request failed'), { code: body.error?.code })
    }
    return body.data as T
  },
}
