import { openRuntimeConfig } from '@ledger/kernel'
import { runHostMain } from './host.js'

const config = await openRuntimeConfig({ watch: true })
const home = config.require<string>('storage.dataDir')
runHostMain(home, config)
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('[host] fatal:', e)
    process.exit(1)
  })
