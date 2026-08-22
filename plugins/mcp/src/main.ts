import { resolveLedgerHome } from '@ledger/plugin-cli'
import { runMcpServer } from './index.js'

const home = resolveLedgerHome()
runMcpServer({ home }).catch((e) => {
  console.error('[mcp] fatal:', e)
  process.exit(1)
})
