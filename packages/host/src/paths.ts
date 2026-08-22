import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveLedgerHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['LEDGER_HOME'] ?? join(homedir(), '.ledger')
}

export function dbPath(home: string): string {
  return join(home, 'ledger.db')
}

export function hostSocketPath(home: string): string {
  return join(home, 'host.sock')
}
