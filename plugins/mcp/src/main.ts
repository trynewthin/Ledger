import { openRuntimeConfig } from '@ledger/kernel'
import { runMcpServer } from './index.js'

const config = await openRuntimeConfig({ watch: true })
const home = config.require<string>('storage.dataDir')
runMcpServer({ home, configProvider: config }).catch((e) => {
  console.error('[mcp] fatal:', e)
  process.exit(1)
})
