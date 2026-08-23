import { pathToFileURL } from 'node:url'
import { CommanderError } from 'commander'
import type { FieldDefDTO, TypeDefDTO } from '@ledger/plugin-contract'
import { runHostMain } from '@ledger/host'
import { buildProgram, type CliContext } from './commands.js'
import { toCliError } from './errors.js'
import { unwrap } from './result.js'
import { withSession } from './session.js'
import { findProjectRoot, initializeProjectConfig, openRuntimeConfig, ProjectInitializationRegistry } from '@ledger/kernel'
import { initializeStorageProject } from '@ledger/storage-sqlite'
import { assembleColdKernel } from './cold-boot.js'

/**
 * CLI 入口：混合自动模式。
 * 宿主在 → socket RPC；不在 → 冷引导直调（同一内核，同一调用协议）。
 */
export async function runCli(argv: string[]): Promise<number> {
  if (isProjectInitCommand(argv)) return runProjectInit(argv)
  const config = await openRuntimeConfig({ watch: argv[0] === 'host' })
  const home = config.require<string>('storage.dataDir')
  // ledger host：常驻宿主前台运行，不经会话（自身就是宿主）
  if (argv[0] === 'host') {
    return runHostMain(home, config)
  }
  const recorder = process.env['LEDGER_RECORDER'] ?? 'me'
  const json = argv.includes('--json')
  try {
    return await withSession({ home, recorder, configProvider: config }, async (session) => {
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
  } finally {
    await config.close()
  }
}

function isProjectInitCommand(argv: string[]): boolean {
  return argv[0] === 'init' || (argv[0] === 'config' && argv[1] === 'init')
}

/**
 * 项目初始化先完成 Config/Storage Core，再冷引导已安装 L1 插件注册扩展初始化器。
 * 生命周期注册顺序即执行顺序，Storage Core 始终先准备好项目数据目录。
 */
async function runProjectInit(argv: string[]): Promise<number> {
  const projectRoot = await findProjectRoot(process.cwd())
  const { config, created } = await initializeProjectConfig({ projectRoot })
  const dataDir = config.require<string>('storage.dataDir')
  const lifecycle = new ProjectInitializationRegistry(projectRoot)
  lifecycle.register('storage', 'core', async () => {
    const initialized = await initializeStorageProject({ dataDir, projectRoot })
    initialized.close()
  })
  try {
    const initialized = await lifecycle.run()
    const boot = await assembleColdKernel(dataDir, config, lifecycle)
    try {
      initialized.push(...(await boot.initialization.run()))
    } finally {
      boot.close()
    }
    const result = { projectRoot, configPath: config.filePath, dataDir, configCreated: created, initialized }
    if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
    else console.log(`✓ 项目已初始化 → ${projectRoot}\n  配置: ${config.filePath}\n  存储: ${dataDir}\n  初始化器: ${initialized.join(', ')}`)
    return 0
  } finally {
    await config.close()
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code))
}
