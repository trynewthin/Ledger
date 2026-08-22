export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly exitCode = 1,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

/** CLI → 人类可读信息 + 非零退出码（错误模型适配器翻译职责） */
export function toCliError(e: unknown): CliError {
  if (e instanceof CliError) return e
  const anyErr = e as { error?: { code: string; message: string; details?: unknown } }
  if (anyErr && typeof anyErr === 'object' && anyErr.error && anyErr.error.code) {
    return new CliError(anyErr.error.code, anyErr.error.message, anyErr.error.details)
  }
  if (e instanceof Error) return new CliError('INTERNAL', e.message)
  return new CliError('INTERNAL', String(e))
}

export function fail(code: string, message: string, details?: unknown): never {
  throw new CliError(code, message, details)
}
