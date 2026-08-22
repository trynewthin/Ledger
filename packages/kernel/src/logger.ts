import type { Logger } from '@ledger/plugin-contract'

export function createLogger(prefix?: string): Logger {
  const tag = prefix ? `[${prefix}]` : '[kernel]'
  return {
    debug: (msg, ...args) => console.debug(tag, msg, ...args),
    info: (msg, ...args) => console.info(tag, msg, ...args),
    warn: (msg, ...args) => console.warn(tag, msg, ...args),
    error: (msg, ...args) => console.error(tag, msg, ...args),
  }
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
