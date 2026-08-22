import { resolveLedgerHome } from './paths.js'
import { runHostMain } from './host.js'

const home = resolveLedgerHome()
runHostMain(home)
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('[host] fatal:', e)
    process.exit(1)
  })
