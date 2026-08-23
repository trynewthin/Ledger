/** 类型化错误码，贯穿内核；适配器负责翻译（CLI→退出码 / HTTP→status / MCP→tool error） */
export type KernelErrorCode =
  | 'COMMAND_NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'INVALID_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'INVALID_DIRECTION'
  | 'INVALID_ENTRY'
  | 'TYPE_NOT_REGISTERED'
  | 'TYPE_DIRECTION_MISMATCH'
  | 'TYPE_KEY_TAKEN'
  | 'FIELD_KEY_TAKEN'
  | 'FIELD_UNKNOWN'
  | 'FIELD_TYPE_MISMATCH'
  | 'FIELD_SCOPE_MISMATCH'
  | 'ENUM_VIOLATION'
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_VOIDED'
  | 'PLUGIN_NOT_FOUND'
  | 'PLUGIN_LOAD_FAILED'
  | 'PLUGIN_ACTIVATE_FAILED'
  | 'PLUGIN_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE'
  | 'USER_NOT_FOUND'
  | 'BOOK_NOT_FOUND'
  | 'BOOK_NAME_TAKEN'
  | 'BOOK_ACTIVE'
  | 'TAG_GROUP_NOT_FOUND'
  | 'TAG_GROUP_NAME_TAKEN'
  | 'TAG_NOT_FOUND'
  | 'TAG_NAME_TAKEN'
  | 'SNAPSHOT_NOT_FOUND'
  | 'NOT_SUPPORTED'
  | 'FORBIDDEN'
  | 'INTERNAL'

export class AppError extends Error {
  constructor(
    public readonly code: KernelErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export interface ErrorEnvelope {
  code: KernelErrorCode | string
  message: string
  details?: unknown
}

export function toErrorEnvelope(e: unknown): ErrorEnvelope {
  if (e instanceof AppError) return { code: e.code, message: e.message, details: e.details }
  if (e instanceof Error) return { code: 'INTERNAL', message: e.message }
  return { code: 'INTERNAL', message: String(e) }
}
