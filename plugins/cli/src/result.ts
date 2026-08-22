import type { DispatchResult } from '@ledger/kernel'
import { CliError } from './errors.js'

export function unwrap<T = any>(res: DispatchResult): T {
  if (!res.ok) throw new CliError(res.error.code, res.error.message, res.error.details)
  return res.data as T
}

export function camelFromKebab(s: string): string {
  return s.replace(/[-_]([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}
