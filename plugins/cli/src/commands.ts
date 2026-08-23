import { Command } from 'commander'
import { join } from 'node:path'
import type { FieldDefDTO, TypeDefDTO } from '@ledger/plugin-contract'
import type { Session } from './session.js'
import { camelFromKebab, unwrap } from './result.js'
import { CliError } from './errors.js'
import { dayEnd, dayStart, formatMoney, formatTs, parseAmountInput, parseOccurredAtInput, printTable } from './output.js'
import { installPluginDir, installUiPluginDir, listInstalledPlugins, listUiPlugins, uninstallPluginDir, uninstallUiPluginDir } from '@ledger/kernel'
import { backupDatabase } from './backup.js'
import { dbPath } from './paths.js'

export interface CliContext {
  session: Session
  home: string
  json: boolean
  recorder: string
  types: TypeDefDTO[]
  fields: FieldDefDTO[]
}

const DIRECTION_CHOICES = ['income', 'expense'] as const

function typeLabel(ctx: CliContext, key: string | null): string {
  if (key === null) return '-'
  const def = ctx.types.find((t) => t.key === key)
  return def && !def.unavailable ? def.label : key
}

/** 动态字段 flag：从 field_defs 注册表自动生成（与 WebUI 表单、MCP tool schema 同源） */
function addFieldOptions(cmd: Command, ctx: CliContext): void {
  for (const f of ctx.fields) {
    if (f.unavailable) continue
    const flag = f.key.replace(/_/g, '-')
    const enumHint = f.valueType === 'enum' ? `；可选: ${f.enumValues?.map((v) => v.value).join('|')}` : ''
    cmd.option(`--${flag} <value>`, `${f.label}（${f.valueType}${enumHint}）`)
  }
}

function extraFromOpts(opts: Record<string, unknown>, fields: FieldDefDTO[]): Record<string, unknown> {
  const extra: Record<string, unknown> = {}
  for (const f of fields) {
    const camel = camelFromKebakMap(f.key)
    const raw = opts[camel]
    if (raw === undefined) continue
    if (f.valueType === 'number') {
      const n = Number(raw)
      if (Number.isNaN(n)) throw new CliError('FIELD_TYPE_MISMATCH', `字段 ${f.key} 需要数字`)
      extra[f.key] = n
    } else if (f.valueType === 'boolean') {
      extra[f.key] = String(raw) === 'true'
    } else {
      extra[f.key] = String(raw)
    }
  }
  return extra
}

function camelFromKebakMap(key: string): string {
  return camelFromKebab(key)
}

export function buildProgram(ctx: CliContext): Command {
  const program = new Command()
  program
    .name('ledger')
    .description('个人财务数据操作系统')
    .version('0.1.0')

  const call = (command: string, payload?: unknown) => ctx.session.call(command, payload)

  // 真实初始化在 runCli 中发生，避免在打开现有账本会话前创建项目资源。
  program
    .command('init')
    .description('初始化当前项目：创建 ledger.config.json 与 .ledger 存储目录')
  program
    .command('config')
    .description('项目配置管理')
    .command('init')
    .description('初始化当前项目配置与已安装插件的初始化器')

  // ---- 记账 ----
  const add = program
    .command('add')
    .description('记一笔账')
    .requiredOption('-d, --direction <dir>', '方向: income | expense', (v) => {
      if (!DIRECTION_CHOICES.includes(v as never)) throw new CliError('VALIDATION_ERROR', `direction 必须是 ${DIRECTION_CHOICES.join(' | ')}`)
      return v
    })
    .requiredOption('-a, --amount <amount>', '金额（十进制，如 12.50）')
    .option('-c, --currency <code>', '货币（ISO 4217，默认 CNY）', 'CNY')
    .option('-t, --type <type>', '类型 key（type list 查看）')
    .option('--at <time>', '业务时间（2026-08-22 | 2026-08-22 14:30 | ISO）')
    .option('--strict', '严格模式：拒绝未注册的 extra 字段')
  addFieldOptions(add, ctx)
  add.action(async (opts) => {
    const currency = String(opts.currency).toUpperCase()
    const payload: any = {
      direction: opts.direction,
      amountMinor: parseAmountInput(opts.amount, currency),
      currency,
      type: opts.type ?? null,
      extra: extraFromOpts(opts, ctx.fields),
    }
    if (opts.at !== undefined) payload.occurredAt = parseOccurredAtInput(opts.at)
    if (opts.strict) payload.strictExtra = true
    const entry = unwrap(await call('entry.add', payload))
    if (ctx.json) {
      console.log(JSON.stringify(entry, null, 2))
    } else {
      const dir = entry.direction === 'income' ? '收入' : '支出'
      console.log(`✓ 已记账 ${dir} ${formatMoney(entry.amountMinor, entry.currency)} ${typeLabel(ctx, entry.type)} @ ${formatTs(entry.occurredAt)}  (${entry.id})`)
    }
  })

  // ---- 流水 ----
  program
    .command('list')
    .description('查询流水')
    .option('-d, --direction <dir>', '按方向过滤')
    .option('-t, --type <type>', '按类型过滤')
    .option('--from <date>', '起始日 YYYY-MM-DD')
    .option('--to <date>', '结束日 YYYY-MM-DD')
    .option('-n, --limit <n>', '条数', parseInt)
    .option('--offset <n>', '偏移', parseInt)
    .option('-a, --all', '包含已作废', false)
    .action(async (opts) => {
      const filter: any = {}
      if (opts.direction) filter.direction = opts.direction
      if (opts.type !== undefined) filter.type = opts.type
      if (opts.from) filter.from = dayStart(opts.from)
      if (opts.to) filter.to = dayEnd(opts.to)
      if (opts.limit) filter.limit = opts.limit
      if (opts.offset) filter.offset = opts.offset
      if (opts.all) filter.includeVoided = true
      const result = unwrap(await call('entry.list', filter))
      if (ctx.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      const rows = result.items.map((e: any) => [
        formatTs(e.occurredAt),
        e.direction === 'income' ? '收入' : '支出',
        formatMoney(e.amountMinor, e.currency),
        typeLabel(ctx, e.type),
        e.recorder,
        e.voidedAt ? '[已作废]' : Object.keys(e.extra).length > 0 ? JSON.stringify(e.extra) : '',
        e.id.slice(-8),
      ])
      printTable(['时间', '方向', '金额', '类型', '记录者', '扩展/状态', 'ID'], rows)
      console.log(`共 ${result.total} 条`)
    })

  program
    .command('get <id>')
    .description('查看一条账目及其修订历史')
    .action(async (id: string) => {
      const entry = unwrap(await call('entry.get', { id }))
      const revisions = unwrap(await call('entry.revisions', { entryId: id }))
      if (ctx.json) {
        console.log(JSON.stringify({ entry, revisions }, null, 2))
        return
      }
      console.log(JSON.stringify(entry, null, 2))
      if (revisions.length > 0) {
        console.log('修订历史:')
        printTable(
          ['#', '时间', '谁', '来源', '原因'],
          revisions.map((r: any, i: number) => [String(i + 1), formatTs(r.revisedAt), r.actor, r.source, r.reason ?? '']),
        )
      }
    })

  // ---- 修订 / 作废 ----
  const revise = program
    .command('revise <id>')
    .description('修订一条账目（前像自动留痕）')
    .option('-a, --amount <amount>', '新金额')
    .option('-c, --currency <code>', '新货币')
    .option('-t, --type <type>', '新类型')
    .option('-d, --direction <dir>', '新方向')
    .option('--at <time>', '新业务时间')
    .option('-r, --reason <reason>', '修订原因')
    .option('--strict', '严格模式')
  addFieldOptions(revise, ctx)
  revise.action(async (id: string, opts) => {
    const patch: any = {}
    if (opts.amount !== undefined) patch.amountMinor = parseAmountInput(opts.amount, opts.currency ?? 'CNY')
    if (opts.currency !== undefined) patch.currency = String(opts.currency).toUpperCase()
    if (opts.type !== undefined) patch.type = opts.type
    if (opts.direction !== undefined) patch.direction = opts.direction
    if (opts.at !== undefined) patch.occurredAt = parseOccurredAtInput(opts.at)
    const extra = extraFromOpts(opts, ctx.fields)
    if (Object.keys(extra).length > 0) patch.extra = extra
    const entry = unwrap(await call('entry.revise', { id, patch, reason: opts.reason ?? null, strictExtra: !!opts.strict }))
    if (ctx.json) console.log(JSON.stringify(entry, null, 2))
    else console.log(`✓ 已修订 → revision ${entry.revision}  (${entry.id})`)
  })

  program
    .command('void <id>')
    .description('作废一条账目（软删，历史可追溯）')
    .requiredOption('-r, --reason <reason>', '作废原因')
    .action(async (id: string, opts) => {
      const entry = unwrap(await call('entry.void', { id, reason: opts.reason }))
      if (ctx.json) console.log(JSON.stringify(entry, null, 2))
      else console.log(`✓ 已作废 (${entry.id})`)
    })

  // ---- 统计 ----
  program
    .command('stats')
    .description('统计: summary | monthly | by-type | by-direction | by-recorder')
    .argument('[kind]', '统计种类', 'summary')
    .option('-d, --direction <dir>', '按方向过滤')
    .option('--from <date>', '起始日')
    .option('--to <date>', '结束日')
    .action(async (kind: string, opts) => {
      const kinds: Record<string, string> = { summary: 'summary', monthly: 'monthly', 'by-type': 'byType', 'by-direction': 'byDirection', 'by-recorder': 'byRecorder' }
      const command = kinds[kind]
      if (!command) throw new CliError('VALIDATION_ERROR', `未知统计: ${kind}`)
      const filter: any = {}
      if (opts.direction) filter.direction = opts.direction
      if (opts.from) filter.from = dayStart(opts.from)
      if (opts.to) filter.to = dayEnd(opts.to)
      const data = unwrap(await call(`stats.${command}`, filter))
      if (ctx.json) {
        console.log(JSON.stringify(data, null, 2))
        return
      }
      if (command === 'summary') {
        for (const [cur, t] of Object.entries<any>(data.income)) console.log(`收入 ${formatMoney(t.totalMinor, cur)} (${t.count} 笔)`)
        for (const [cur, t] of Object.entries<any>(data.expense)) console.log(`支出 ${formatMoney(t.totalMinor, cur)} (${t.count} 笔)`)
        for (const [cur, n] of Object.entries<any>(data.net)) console.log(`净额 ${n >= 0 ? '+' : ''}${formatMoney(n, cur)}`)
        if (Object.keys(data.income).length === 0 && Object.keys(data.expense).length === 0) console.log('（暂无数据）')
      } else if (command === 'monthly') {
        printTable(['月份', '收入', '支出'], (data as any[]).map((m) => {
          const inc = Object.entries<any>(m.income).map(([c, t]) => formatMoney(t.totalMinor, c)).join(' ') || '-'
          const exp = Object.entries<any>(m.expense).map(([c, t]) => formatMoney(t.totalMinor, c)).join(' ') || '-'
          return [m.month, inc, exp]
        }))
      } else if (command === 'byType') {
        printTable(['类型', '方向', '金额'], (data as any[]).map((t) => [
          typeLabel(ctx, t.type),
          t.direction === 'income' ? '收入' : '支出',
          Object.entries<any>(t.totals).map(([c, v]) => `${formatMoney(v.totalMinor, c)} (${v.count})`).join(' ') || '-',
        ]))
      } else if (command === 'byRecorder') {
        printTable(['记录者', '金额'], (data as any[]).map((t) => [
          t.recorder,
          Object.entries<any>(t.totals).map(([c, v]) => `${formatMoney(v.totalMinor, c)} (${v.count})`).join(' ') || '-',
        ]))
      } else {
        printTable(['方向', '金额'], (data as any[]).map((t) => [
          t.direction === 'income' ? '收入' : '支出',
          Object.entries<any>(t.totals).map(([c, v]) => `${formatMoney(v.totalMinor, c)} (${v.count})`).join(' ') || '-',
        ]))
      }
    })

  // ---- 类型注册（运行时扩充，origin: user） ----
  const typeCmd = program.command('type').description('类型注册表管理')
  typeCmd
    .command('add <key>')
    .description('注册类型（强制声明 direction 映射）')
    .requiredOption('-l, --label <label>', '显示名')
    .requiredOption('-d, --direction <dir>', 'income | expense')
    .option('-p, --parent <key>', '父类型（类型层级）')
    .option('--icon <icon>', 'lucide 图标名')
    .action(async (key: string, opts) => {
      const def = unwrap(await call('type.register', {
        key, label: opts.label, direction: opts.direction,
        parentKey: opts.parent ?? null, icon: opts.icon ?? null,
      }))
      if (ctx.json) console.log(JSON.stringify(def, null, 2))
      else console.log(`✓ 类型已注册: ${def.key} (${def.label})`)
    })

  typeCmd
    .command('list')
    .description('列出已注册类型')
    .option('-d, --direction <dir>', '按方向过滤')
    .action(async (opts) => {
      const types = unwrap(await call('type.list', opts.direction ? { direction: opts.direction } : {}))
      if (ctx.json) return console.log(JSON.stringify(types, null, 2))
      printTable(
        ['key', '名称', '方向', '父类型', '图标', '来源', '状态'],
        types.map((t: TypeDefDTO) => [
          t.key, t.label, t.direction === 'income' ? '收入' : '支出',
          t.parentKey ?? '-', t.icon ?? '-', t.origin, t.unavailable ? '不可用' : (t.enabled ? '启用' : '停用'),
        ]),
      )
    })

  // ---- 字段注册 ----
  const fieldCmd = program.command('field').description('动态字段注册表管理')
  fieldCmd
    .command('add <key>')
    .description('注册动态字段')
    .requiredOption('-l, --label <label>', '显示名')
    .requiredOption('-s, --scope <scope>', 'expense | income | both')
    .requiredOption('-v, --value-type <type>', 'string | number | enum | date | boolean')
    .option('-e, --enum-values <values>', '枚举值: alipay:支付宝,wechat:微信')
    .action(async (key: string, opts) => {
      const payload: any = { key, label: opts.label, scope: opts.scope, valueType: opts.valueType }
      if (opts.enumValues) {
        payload.enumValues = String(opts.enumValues).split(',').map((item) => {
          const [value, label] = item.split(':')
          return { value: value.trim(), label: (label ?? value).trim() }
        })
      }
      const def = unwrap(await call('field.register', payload))
      if (ctx.json) console.log(JSON.stringify(def, null, 2))
      else console.log(`✓ 字段已注册: ${def.key} (${def.label})`)
    })

  fieldCmd
    .command('list')
    .description('列出已注册字段')
    .action(async () => {
      const fields = unwrap(await call('field.list', {}))
      if (ctx.json) return console.log(JSON.stringify(fields, null, 2))
      printTable(
        ['key', '名称', '范围', '类型', '枚举值', '来源'],
        fields.map((f: FieldDefDTO) => [
          f.key, f.label, f.scope, f.valueType,
          f.enumValues ? f.enumValues.map((v) => v.value).join('|') : '-',
          f.origin,
        ]),
      )
    })

  // ---- Book Core：账本 = 完整项目状态，不是单条 Entry 的分区 ----
  const bookCmd = program.command('book').description('账本管理（Book Core）')
  bookCmd
    .command('create <name>')
    .description('将当前完整项目状态保存为账本并设为当前账本')
    .action(async (name: string) => {
      const book = unwrap<any>(await call('book.create', { name }))
      if (ctx.json) console.log(JSON.stringify(book, null, 2))
      else console.log(`✓ 已创建并切换到账本 ${book.name} (${book.id})`)
    })
  bookCmd
    .command('list')
    .description('列出账本')
    .action(async () => {
      const [books, current] = await Promise.all([
        unwrap<any[]>(await call('book.list')),
        unwrap<any>(await call('book.current')),
      ])
      if (ctx.json) return console.log(JSON.stringify({ books, current }, null, 2))
      printTable(
        ['名称', '当前', '创建时间', 'ID'],
        books.map((book) => [book.name, current?.id === book.id ? '是' : '', formatTs(book.createdAt), book.id]),
      )
    })
  bookCmd
    .command('current')
    .description('读取当前账本')
    .action(async () => {
      const book = unwrap<any>(await call('book.current'))
      if (ctx.json) console.log(JSON.stringify(book ?? null, null, 2))
      else console.log(book ? `${book.name} (${book.id})` : '（尚未创建账本）')
    })
  bookCmd
    .command('delete <id>')
    .description('删除非当前账本')
    .action(async (id: string) => {
      const result = unwrap(await call('book.delete', { id }))
      if (ctx.json) console.log(JSON.stringify(result, null, 2))
      else console.log(`✓ 已删除账本 ${id}`)
    })
  bookCmd
    .command('switch <id>')
    .description('切换完整项目状态；常驻宿主需要重启后重建插件运行态')
    .action(async (id: string) => {
      const result = unwrap<any>(await call('book.switch', { id }))
      if (ctx.json) console.log(JSON.stringify(result, null, 2))
      else console.log(`✓ 已切换到账本 ${result.book.name}${result.restartRequired ? '；请重启常驻宿主' : ''}`)
    })
  const bookTagCmd = bookCmd.command('tag').description('账本标签绑定（plugin-core-types）')
  bookTagCmd
    .command('bind <bookId> <tagIds...>')
    .description('为账本绑定一个或多个标签')
    .action(async (bookId: string, tagIds: string[]) => printTagBinding(ctx, unwrap(await call('book.tag.bind', { bookId, tagIds }))))
  bookTagCmd
    .command('unbind <bookId> <tagIds...>')
    .description('解除账本标签绑定')
    .action(async (bookId: string, tagIds: string[]) => printTagBinding(ctx, unwrap(await call('book.tag.unbind', { bookId, tagIds }))))
  bookTagCmd
    .command('list <bookId>')
    .description('读取账本标签及其反查标签组')
    .action(async (bookId: string) => printTagBinding(ctx, unwrap(await call('book.tag.list', { bookId }))))

  // ---- 标签：标签组与标签的 CRUD 均由 plugin-core-types 提供 ----
  const tagCmd = program.command('tag').description('标签管理（plugin-core-types）')
  const tagGroupCmd = tagCmd.command('group').description('标签组管理')
  tagGroupCmd
    .command('create <name>')
    .description('创建标签组')
    .action(async (name: string) => printJsonOrTable(ctx, unwrap(await call('tag-group.create', { name })), ['ID', '名称'], (group: any) => [[group.id, group.name]]))
  tagGroupCmd
    .command('list')
    .description('列出标签组')
    .action(async () => printJsonOrTable(ctx, unwrap(await call('tag-group.list')), ['ID', '名称'], (groups: any[]) => groups.map((group) => [group.id, group.name])))
  tagGroupCmd
    .command('get <id>')
    .description('读取标签组')
    .action(async (id: string) => printJsonOrTable(ctx, unwrap(await call('tag-group.get', { id })), ['ID', '名称'], (group: any) => [[group.id, group.name]]))
  tagGroupCmd
    .command('update <id> <name>')
    .description('更新标签组')
    .action(async (id: string, name: string) => printJsonOrTable(ctx, unwrap(await call('tag-group.update', { id, name })), ['ID', '名称'], (group: any) => [[group.id, group.name]]))
  tagGroupCmd
    .command('delete <id>')
    .description('删除标签组及其标签绑定')
    .action(async (id: string) => {
      const result = unwrap(await call('tag-group.delete', { id }))
      if (ctx.json) console.log(JSON.stringify(result, null, 2))
      else console.log(`✓ 已删除标签组 ${id}`)
    })
  tagCmd
    .command('create <groupId> <name>')
    .description('在标签组中创建标签')
    .action(async (groupId: string, name: string) => printJsonOrTable(ctx, unwrap(await call('tag.create', { groupId, name })), ['ID', '标签组', '名称'], (tag: any) => [[tag.id, tag.groupId, tag.name]]))
  tagCmd
    .command('list')
    .description('列出标签')
    .option('-g, --group <id>', '按标签组过滤')
    .action(async (opts) => printJsonOrTable(ctx, unwrap(await call('tag.list', opts.group ? { groupId: opts.group } : {})), ['ID', '标签组', '名称'], (tags: any[]) => tags.map((tag) => [tag.id, tag.groupId, tag.name])))
  tagCmd
    .command('get <id>')
    .description('读取标签')
    .action(async (id: string) => printJsonOrTable(ctx, unwrap(await call('tag.get', { id })), ['ID', '标签组', '名称'], (tag: any) => [[tag.id, tag.groupId, tag.name]]))
  tagCmd
    .command('update <id>')
    .description('更新标签名称或移动到另一标签组')
    .option('-n, --name <name>', '新名称')
    .option('-g, --group <groupId>', '目标标签组')
    .action(async (id: string, opts) => {
      const payload: Record<string, string> = { id }
      if (opts.name !== undefined) payload.name = opts.name
      if (opts.group !== undefined) payload.groupId = opts.group
      const tag = unwrap(await call('tag.update', payload))
      printJsonOrTable(ctx, tag, ['ID', '标签组', '名称'], (item: any) => [[item.id, item.groupId, item.name]])
    })
  tagCmd
    .command('delete <id>')
    .description('删除标签及其账本绑定')
    .action(async (id: string) => {
      const result = unwrap(await call('tag.delete', { id }))
      if (ctx.json) console.log(JSON.stringify(result, null, 2))
      else console.log(`✓ 已删除标签 ${id}`)
    })

  // ---- 身份目录（plugin-user 提供 'user' 服务；不在场则 SERVICE_UNAVAILABLE） ----
  const userCmd = program.command('user').description('身份目录（plugin-user）')
  userCmd
    .command('list')
    .description('列出用户')
    .action(async () => {
      const users = unwrap(await call('user.list'))
      if (ctx.json) return console.log(JSON.stringify(users, null, 2))
      printTable(
        ['id', '名称', '种类', '默认', '创建时间'],
        users.map((u: any) => [u.id, u.name, u.kind === 'bot' ? '机器人' : '人', u.isDefault ? '是' : '否', formatTs(u.createdAt)]),
      )
    })
  userCmd
    .command('get [id]')
    .description('查看用户（缺省为当前默认身份）')
    .action(async (id?: string) => {
      const user = unwrap(await call('user.get', id ? { id } : {}))
      if (ctx.json) return console.log(JSON.stringify(user, null, 2))
      console.log(`${user.name} (${user.id}) · ${user.kind === 'bot' ? '机器人' : '人'}${user.isDefault ? ' · 默认' : ''}`)
    })

  // ---- 插件管理（AdminHostAPI 语义；冷引导下 install/uninstall 为文件操作） ----
  const pluginCmd = program.command('plugin').description('插件管理（admin）')
  pluginCmd
    .command('list')
    .description('列出已安装插件')
    .action(async () => {
      const installed = await listInstalledPlugins(ctx.home)
      const loadedRes = await call('plugin.list', {})
      const loaded = loadedRes.ok ? (loadedRes.data as any[]) : []
      if (ctx.json) return console.log(JSON.stringify({ installed, loaded }, null, 2))
      printTable(
        ['插件', '版本', '隔离', '启用', '本进程'],
        installed.map((p) => [
          p.name, p.manifest.version ?? '-', p.manifest.isolation ?? 'inprocess',
          p.enabled ? '是' : '否',
          loaded.find?.((l: any) => l.name === p.name)?.state ?? '-',
        ]),
      )
    })

  pluginCmd
    .command('install <dir>')
    .description('从目录安装插件')
    .action(async (dir: string) => {
      const installed = await installPluginDir(dir, ctx.home)
      if (ctx.session.mode === 'rpc') {
        await call('plugin.load', { name: installed.name })
      }
      if (ctx.json) console.log(JSON.stringify(installed, null, 2))
      else console.log(`✓ 已安装 ${installed.name} → ${installed.dir}`)
    })

  pluginCmd
    .command('load <name>')
    .description('加载已安装插件（需宿主运行）')
    .action(async (name: string) => {
      requireRpc(ctx, 'plugin load')
      const info = unwrap(await call('plugin.load', { name }))
      if (ctx.json) console.log(JSON.stringify(info, null, 2))
      else console.log(`✓ 已加载 ${info.name} (${info.state})`)
    })

  pluginCmd
    .command('reload <name>')
    .description('热替换插件（L1 失败自动回滚 / L2 worker 重引导）')
    .action(async (name: string) => {
      requireRpc(ctx, 'plugin reload')
      const info = unwrap(await call('plugin.reload', { name }))
      if (ctx.json) console.log(JSON.stringify(info, null, 2))
      else console.log(`✓ 已重载 ${info.name} → v${info.version}`)
    })

  pluginCmd
    .command('uninstall <name>')
    .description('卸载插件')
    .action(async (name: string) => {
      await call('plugin.unload', { name }).catch(() => undefined)
      await uninstallPluginDir(name, ctx.home)
      if (ctx.json) console.log(JSON.stringify({ uninstalled: name }))
      else console.log(`✓ 已卸载 ${name}`)
    })

  // ---- UI 插件管理（webui shell 内的浏览器插件） ----
  const uiCmd = program.command('ui').description('UI 插件管理（webui）')
  uiCmd
    .command('install <dir>')
    .description('安装 UI 插件目录（含 ui-plugin.json）')
    .action(async (dir: string) => {
      const installed = await installUiPluginDir(dir, ctx.home)
      if (ctx.json) console.log(JSON.stringify(installed, null, 2))
      else console.log(`✓ UI 插件已安装 ${installed.name} v${installed.version}`)
    })
  uiCmd
    .command('uninstall <name>')
    .description('卸载 UI 插件')
    .action(async (name: string) => {
      await uninstallUiPluginDir(name, ctx.home)
      if (ctx.json) console.log(JSON.stringify({ uninstalled: name }))
      else console.log(`✓ UI 插件已卸载 ${name}`)
    })
  uiCmd
    .command('list')
    .description('列出已安装 UI 插件')
    .action(async () => {
      const list = await listUiPlugins(ctx.home)
      if (ctx.json) return console.log(JSON.stringify(list, null, 2))
      printTable(
        ['插件', '版本', '入口', '目录'],
        list.map((p) => [p.name, p.version, p.entry, p.dir]),
      )
    })

  program
    .command('host')
    .description('启动常驻宿主（前台运行；CLI 将自动走 RPC 路径）')
    .action(() => {
      // 实际启动在 runCli 中拦截（不经会话）
    })

  // ---- 备份 ----
  program
    .command('backup')
    .description('备份数据库（SQLite backup，单文件即备份单元）')
    .option('-o, --out <file>', '目标文件（默认 <home>/backups/ledger-<时间戳>.db）')
    .action(async (opts) => {
      const ts = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      const stamp = `${ts.getFullYear()}${p(ts.getMonth() + 1)}${p(ts.getDate())}-${p(ts.getHours())}${p(ts.getMinutes())}${p(ts.getSeconds())}`
      const dest = opts.out ?? join(ctx.home, 'backups', `ledger-${stamp}.db`)
      await backupDatabase(dbPath(ctx.home), dest)
      if (ctx.json) console.log(JSON.stringify({ backup: dest }))
      else console.log(`✓ 备份完成 → ${dest}`)
    })

  return program
}

/** 冷引导一次性进程里 load/reload 无意义——提示需宿主运行（AdminHostAPI 语义差异） */
function requireRpc(ctx: CliContext, op: string): void {
  if (ctx.session.mode !== 'rpc') {
    throw new CliError('NOT_SUPPORTED', `${op} 需常驻宿主运行：先启动 ledger host`)
  }
}

function printTagBinding(ctx: CliContext, binding: any): void {
  if (ctx.json) {
    console.log(JSON.stringify(binding, null, 2))
    return
  }
  const groups = new Map((binding.groups ?? []).map((group: any) => [group.id, group.name]))
  printTable(
    ['标签', '标签组'],
    (binding.tags ?? []).map((tag: any) => [tag.name, groups.get(tag.groupId) ?? tag.groupId]),
  )
}

function printJsonOrTable<T>(
  ctx: CliContext,
  value: T,
  headers: string[],
  rows: (value: T) => string[][],
): void {
  if (ctx.json) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  printTable(headers, rows(value))
}
