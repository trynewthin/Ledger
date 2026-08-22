import { homedir } from 'node:os'
import { join } from 'node:path'

/** Ledger 主目录：LEDGER_HOME 覆盖（测试用），默认 ~/.ledger */
export function resolveLedgerHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['LEDGER_HOME'] ?? join(homedir(), '.ledger')
}

export function dbPath(home: string): string {
  return join(home, 'ledger.db')
}

export function hostSocketPath(home: string): string {
  return join(home, 'host.sock')
}
