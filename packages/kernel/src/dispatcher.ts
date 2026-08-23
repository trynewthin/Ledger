import type { CallContext, CommandDescriptor } from '@ledger/plugin-contract'
import { DomainError } from '@ledger/domain'
import { AppError, toErrorEnvelope } from './errors.js'
import type { Logger } from '@ledger/plugin-contract'

export interface DispatchRequest {
  command: string
  payload?: unknown
  /** context 由调用方携带 source/recorder 意图，dispatcher 组装并注入默认值 */
  context?: { source?: string; recorder?: string }
}

export interface DispatchOk {
  ok: true
  data: unknown
}

export interface DispatchError {
  ok: false
  error: { code: string; message: string; details?: unknown }
}

export type DispatchResult = DispatchOk | DispatchError

export type CommandHandler = (payload: any, context: CallContext) => unknown | Promise<unknown>

/**
 * 统一调用协议：`{ command, payload, context }`。
 * 同一格式用于进程内直调（CLI/MCP 冷引导）与跨进程（CLI↔host socket RPC、HTTP）。
 * source/recorder 是调用链元数据，不是用户输入——这里自动注入。
 */
export class Dispatcher {
  private commands = new Map<string, { handler: CommandHandler; descriptor: CommandDescriptor }>()

  constructor(private log: Logger = { debug() {}, info() {}, warn() {}, error() {} }) {}

  register(command: string | CommandDescriptor, handler: CommandHandler): void {
    const descriptor = typeof command === 'string' ? defaultDescriptor(command) : command
    if (this.commands.has(descriptor.name)) {
      throw new Error(`command already registered: ${descriptor.name}`)
    }
    this.commands.set(descriptor.name, { handler, descriptor: structuredClone(descriptor) })
  }

  unregister(command: string): void {
    this.commands.delete(command)
  }

  has(command: string): boolean {
    return this.commands.has(command)
  }

  listCommands(): string[] {
    return [...this.commands.keys()].sort()
  }

  /** 能力描述与 handler 同处注册，避免各通信入口维护第二份命令目录。 */
  describeCommands(): CommandDescriptor[] {
    return [...this.commands.values()]
      .map((entry) => structuredClone(entry.descriptor))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  describe(command: string, descriptor: Omit<CommandDescriptor, 'name'>): void {
    const entry = this.commands.get(command)
    if (!entry) throw new Error(`cannot describe unregistered command: ${command}`)
    entry.descriptor = structuredClone({ name: command, ...descriptor })
  }

  async dispatch(req: DispatchRequest): Promise<DispatchResult> {
    const entry = this.commands.get(req.command)
    if (!entry) {
      return { ok: false, error: { code: 'COMMAND_NOT_FOUND', message: `unknown command: ${req.command}` } }
    }
    const context: CallContext = {
      source: req.context?.source ?? 'internal',
      recorder: req.context?.recorder ?? 'me',
    }
    try {
      const data = await entry.handler(req.payload ?? {}, context)
      return { ok: true, data }
    } catch (e) {
      if (e instanceof DomainError) {
        return { ok: false, error: { code: e.code, message: e.message } }
      }
      if (e instanceof AppError || e instanceof Error) {
        if (!(e instanceof AppError)) this.log.error(`command ${req.command} failed`, e)
        return { ok: false, error: toErrorEnvelope(e) }
      }
      this.log.error(`command ${req.command} failed`, e)
      return { ok: false, error: { code: 'INTERNAL', message: String(e) } }
    }
  }
}

function defaultDescriptor(name: string): CommandDescriptor {
  const [domain = 'internal', ...actionParts] = name.split('.')
  return {
    name,
    domain,
    action: actionParts.join('.') || 'invoke',
    description: name,
  }
}
