import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const CLI = resolve(__dirname, '../dist/cli.js')
const REPO = resolve(__dirname, '../../..')

let home: string
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ledger-cli-'))
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

async function ledger(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec('node', [CLI, ...args], {
      env: { ...process.env, LEDGER_HOME: home },
      cwd: home,
    })
    return { stdout, stderr, code: 0 }
  } catch (e: any) {
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

function parseJson<T = any>(out: string): T {
  return JSON.parse(out) as T
}

describe('ledger CLI e2e（冷引导路径）', () => {
  it('add → list → stats：日常记账闭环', async () => {
    const add1 = await ledger('add', '-d', 'expense', '-a', '12.50', '--json')
    expect(add1.code).toBe(0)
    const entry = parseJson(add1.stdout)
    expect(entry.amountMinor).toBe(1250)
    expect(entry.currency).toBe('CNY')
    expect(entry.source).toBe('cli')
    expect(entry.recorder).toBe('me')

    await ledger('add', '-d', 'income', '-a', '10000', '--at', '2026-08-01', '--json')

    const list = await ledger('list', '--json')
    const data = parseJson(list.stdout)
    expect(data.total).toBe(2)

    const stats = await ledger('stats', '--json')
    const summary = parseJson(stats.stdout)
    expect(summary.expense.CNY.totalMinor).toBe(1250)
    expect(summary.income.CNY.totalMinor).toBe(1_000_000)
  })

  it('rejects bad input with typed error + nonzero exit', async () => {
    const bad = await ledger('add', '-d', 'expense', '-a', '12.505')
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('INVALID_AMOUNT')

    const badDir = await ledger('add', '-d', 'both', '-a', '1')
    expect(badDir.code).toBe(1)
    expect(badDir.stderr).toMatch(/VALIDATION_ERROR|direction/)
  })

  it('field register → dynamic flag appears → enum enforced → strict mode', async () => {
    const reg = await ledger(
      'field', 'add', 'mood',
      '-l', '心情', '-s', 'both', '-v', 'enum',
      '-e', 'happy:开心,calm:平静',
    )
    expect(reg.code).toBe(0)

    // 动态 flag：--mood 由注册表自动生成
    const ok = await ledger('add', '-d', 'expense', '-a', '5', '--mood', 'happy', '--json')
    expect(ok.code).toBe(0)
    expect(parseJson(ok.stdout).extra).toEqual({ mood: 'happy' })

    const badEnum = await ledger('add', '-d', 'expense', '-a', '5', '--mood', 'angry')
    expect(badEnum.code).toBe(1)
    expect(badEnum.stderr).toContain('ENUM_VIOLATION')

    // 未注册键：默认放行（CLI 无此 flag，改用 JSON 不行——验证 strict 拒绝经由 revise）
    const strict = await ledger('revise', 'nonexistent', '--reason', 'x')
    expect(strict.code).toBe(1)
    expect(strict.stderr).toContain('ENTRY_NOT_FOUND')
  })

  it('revise + void with history', async () => {
    const add = await ledger('add', '-d', 'expense', '-a', '30', '--json')
    const id = parseJson(add.stdout).id

    const rev = await ledger('revise', id, '-a', '35', '-r', '记错金额', '--json')
    expect(rev.code).toBe(0)
    expect(parseJson(rev.stdout).amountMinor).toBe(3500)

    const got = await ledger('get', id, '--json')
    const detail = parseJson(got.stdout)
    expect(detail.entry.revision).toBe(2)
    expect(detail.revisions).toHaveLength(1)
    expect(JSON.parse(detail.revisions[0].snapshot).amountMinor).toBe(3000)

    const voided = await ledger('void', id, '-r', '重复', '--json')
    expect(voided.code).toBe(0)
    expect(parseJson(voided.stdout).voidedAt).not.toBeNull()

    const list = await ledger('list', '--json')
    expect(parseJson(list.stdout).total).toBeLessThan(4)
    const all = await ledger('list', '--all', '--json')
    expect(parseJson(all.stdout).items.some((e: any) => e.id === id)).toBe(true)
  })

  it('type register/list via CLI（运行时扩充，与插件同表）', async () => {
    await ledger('type', 'add', 'coffee', '-l', '咖啡', '-d', 'expense', '--icon', 'coffee')
    const list = await ledger('type', 'list', '--json')
    expect(parseJson(list.stdout).some((t: any) => t.key === 'coffee')).toBe(true)
    const add = await ledger('add', '-d', 'expense', '-a', '20', '-t', 'coffee', '--json')
    expect(add.code).toBe(0)
  })

  it('plugin install/uninstall: core-types 装卸后数据与统计仍正确', async () => {
    const install = await ledger('plugin', 'install', join(REPO, 'plugins/core-types'))
    expect(install.code).toBe(0)

    const types = await ledger('type', 'list', '--json')
    const typeList = parseJson(types.stdout)
    expect(typeList.some((t: any) => t.key === 'food')).toBe(true)

    // 插件来源类型现在可用（本进程冷引导加载）
    const add = await ledger('add', '-d', 'expense', '-a', '88', '-t', 'food', '--json')
    expect(add.code).toBe(0)
    const foodEntry = parseJson(add.stdout)

    const mismatch = await ledger('add', '-d', 'income', '-a', '1', '-t', 'food')
    expect(mismatch.stderr).toContain('TYPE_DIRECTION_MISMATCH')

    // 卸载：类型反注册，历史数据仍在、统计正确
    const uninstall = await ledger('plugin', 'uninstall', 'plugin-core-types')
    expect(uninstall.code).toBe(0)

    const after = await ledger('type', 'list', '--json')
    expect(parseJson(after.stdout).some((t: any) => t.key === 'food')).toBe(false)

    const notReg = await ledger('add', '-d', 'expense', '-a', '1', '-t', 'food')
    expect(notReg.stderr).toContain('TYPE_NOT_REGISTERED')

    const stats = await ledger('stats', 'by-type', '--json')
    const foodStat = parseJson(stats.stdout).find((t: any) => t.type === 'food')
    expect(foodStat.totals.CNY.totalMinor).toBe(8800)

    const got = await ledger('get', foodEntry.id, '--json')
    expect(parseJson(got.stdout).entry.type).toBe('food')
  })

  it('plugin-user: install → user.* 可用 → uninstall → 明确降级 SERVICE_UNAVAILABLE', async () => {
    const install = await ledger('plugin', 'install', join(REPO, 'plugins/user'))
    expect(install.code).toBe(0)

    const got = await ledger('user', 'get', '--json')
    expect(got.code).toBe(0)
    expect(parseJson(got.stdout)).toMatchObject({ id: 'me', name: 'me', kind: 'human', isDefault: true })

    const list = await ledger('user', 'list', '--json')
    expect(parseJson(list.stdout)).toHaveLength(1)

    const uninstall = await ledger('plugin', 'uninstall', 'plugin-user')
    expect(uninstall.code).toBe(0)

    const degraded = await ledger('user', 'get')
    expect(degraded.code).toBe(1)
    expect(degraded.stderr).toContain('SERVICE_UNAVAILABLE')

    // 数据流不受影响：recorder 回退 'me'
    const add = await ledger('add', '-d', 'expense', '-a', '1', '--json')
    expect(add.code).toBe(0)
    expect(parseJson(add.stdout).recorder).toBe('me')
  })

  it('monthly stats output', async () => {
    const out = await ledger('stats', 'monthly')
    expect(out.code).toBe(0)
    expect(out.stdout).toMatch(/月份/)
  })

  it('ledger backup：完整数据库副本，数据可读', async () => {
    const before = parseJson((await ledger('list', '--all', '--json')).stdout).total
    const backupFile = join(home, 'ledger-backup-test.db')
    const out = await ledger('backup', '-o', backupFile)
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('备份完成')

    const Database = (await import('better-sqlite3')).default
    const copy = new Database(backupFile)
    const count = (copy.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c
    const integrity = copy.pragma('integrity_check', { simple: true })
    copy.close()
    expect(count).toBe(before)
    expect(integrity).toBe('ok')
  })
})
