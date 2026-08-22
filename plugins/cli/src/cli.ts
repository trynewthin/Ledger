import { pathToFileURL } from 'node:url'
import { CommanderError } from 'commander'
import type { FieldDefDTO, TypeDefDTO } from '@ledger/plugin-contract'
import { buildProgram, type CliContext } from './commands.js'
import { toCliError } from './errors.js'
import { resolveLedgerHome } from './paths.js'
import { unwrap } from './result.js'
import { withSession } from './session.js'

/**
 * CLI 入口：混合自动模式。
 * 宿主在 → socket RPC；不在 → 冷引导直调（同一内核，同一调用协议）。
 */
export async function runCli(argv: string[]): Promise<number> {
  const home = resolveLedgerHome()
  const recorder = process.env['LEDGER_RECORDER'] ?? 'me'
  const json = argv.includes('--json')
  try {
    return await withSession({ home, recorder }, async (session) => {
      const [types, fields] = await Promise.all([
        unwrap<TypeDefDTO[]>(await session.call('type.list', {})),
        unwrap<FieldDefDTO[]>(await session.call('field.list', {})),
      ])
      const ctx: CliContext = { session, home, json, recorder, types, fields }
      const program = buildProgram(ctx).exitOverride()
      // --json 在此预扫描，不让 commander 处理（避免逐命令注册）
      const argvForParse = json ? argv.filter((a) => a !== '--json') : argv
      await program.parseAsync(argvForParse, { from: 'user' })
      return 0
    })
  } catch (e) {
    if (e instanceof CommanderError) {
      // help/version 正常退出码为 0，用法错误为 1
      return e.exitCode ?? 1
    }
    const ce = toCliError(e)
    console.error(`✗ [${ce.code}] ${ce.message}`)
    if (ce.details !== undefined) console.error(JSON.stringify(ce.details))
    return 1
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code))
}
