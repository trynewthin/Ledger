import { mkdirSync, rmSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
const dir = resolve('.e2e')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir)
execFileSync('go', ['build', '-o', resolve(dir, 'ledger'), './cmd/ledger'], { cwd: '..', stdio: 'inherit' })
const child = spawn(resolve(dir, 'ledger'), [], { stdio: 'inherit', env: { ...process.env, LEDGER_DB: resolve(dir, 'ledger.db'), LEDGER_WEB: resolve('dist'), LEDGER_ADMIN_USER: 'test-owner', LEDGER_ADMIN_PASSWORD: 'browser-test-password-1234', LEDGER_ADMIN_PASSWORD_FILE: '', LEDGER_ORIGIN: 'http://127.0.0.1:18089', LEDGER_ADDR: '127.0.0.1:18089' } })
process.on('SIGTERM', () => child.kill('SIGTERM'))
process.on('SIGINT', () => child.kill('SIGTERM'))
child.on('exit', code => process.exit(code ?? 0))
