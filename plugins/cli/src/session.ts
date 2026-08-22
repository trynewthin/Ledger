import type { DispatchRequest, DispatchResult, Kernel } from '@ledger/kernel'
import { assembleColdKernel } from './cold-boot.js'
import { hostSocketPath } from './paths.js'
import { tryRpcConnect, type RpcClient } from './rpc.js'

export type SessionMode = 'rpc' | 'cold'

export interface Session {
  mode: SessionMode
  call(command: string, payload?: unknown): Promise<DispatchResult>
  /** 仅冷引导路径暴露内核（进程内直调场景） */
  kernel?: Kernel
  close(): Promise<void>
}

/**
 * 混合自动模式：宿主在 → 本地 socket RPC（毫秒级）；不在 → 冷引导直调。
 * 对命令层完全透明：同一 { command, payload, context } 协议。
 */
export async function openSession(opts: {
  home: string
  recorder: string
}): Promise<Session> {
  const context = { source: 'cli', recorder: opts.recorder }
  const rpc: RpcClient | null = await tryRpcConnect(hostSocketPath(opts.home))
  if (rpc) {
    return {
      mode: 'rpc',
      call: (command, payload) => rpc.call({ command, payload, context }),
      close: async () => rpc.close(),
    }
  }
  const boot = await assembleColdKernel(opts.home)
  return {
    mode: 'cold',
    kernel: boot.kernel,
    call: (command, payload) => boot.kernel.dispatcher.dispatch({ command, payload, context }),
    close: async () => boot.close(),
  }
}

export async function withSession<T>(
  opts: { home: string; recorder: string },
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const session = await openSession(opts)
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}
