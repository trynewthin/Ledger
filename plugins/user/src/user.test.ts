import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { definePlugin, type LedgerPlugin } from '@ledger/plugin-contract'
import { InMemoryEntryRepository, InMemoryMetadataStore } from '@ledger/domain'
import { createKernel, type Kernel, type KernelErrorCode } from '@ledger/kernel'
import { migrate, openDatabase, SqliteEntryRepository, SqliteMetadataStore } from '@ledger/storage-sqlite'
import { userPlugin } from './index.js'

/** 与入口装配同构：sqlite 内核 + 'db' 服务 */
function bootKernel(): { kernel: Kernel; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'ledger-user-'))
  const db = openDatabase(join(home, 'ledger.db'))
  migrate(db)
  const kernel = createKernel({
    repo: new SqliteEntryRepository(db),
    metaStore: new SqliteMetadataStore(db),
    config: { dataDir: home },
  })
  kernel.services.provide('db', db, 'entry')
  return { kernel, home }
}

async function call(kernel: Kernel, command: string, payload?: unknown) {
  return kernel.dispatcher.dispatch({ command, payload, context: { source: 'cli' } })
}

async function errCode(kernel: Kernel, command: string, payload?: unknown): Promise<KernelErrorCode | string> {
  const res = await call(kernel, command, payload)
  if (res.ok) throw new Error(`expected ${command} to fail`)
  return (res as { ok: false; error: { code: string } }).error.code
}

describe('plugin-user', () => {
  const homes: string[] = []
  afterAll(() => {
    for (const h of homes) rmSync(h, { recursive: true, force: true })
  })

  it('seeds default user me; user.* commands work via dispatcher', async () => {
    const { kernel, home } = bootKernel()
    homes.push(home)
    await kernel.loadPlugins([userPlugin])

    expect(kernel.services.get('user')).toBeDefined()
    expect(kernel.services.get<{ getUserId(): string }>('user')!.getUserId()).toBe('me')

    const got = await call(kernel, 'user.get', {})
    expect(got.ok).toBe(true)
    expect((got as { ok: true; data: any }).data).toMatchObject({ id: 'me', name: 'me', kind: 'human', isDefault: true })

    const byId = await call(kernel, 'user.get', { id: 'me' })
    expect((byId as { ok: true; data: any }).data.id).toBe('me')

    const list = await call(kernel, 'user.list')
    expect((list as { ok: true; data: any[] }).data).toHaveLength(1)

    expect(await errCode(kernel, 'user.get', { id: 'nobody' })).toBe('USER_NOT_FOUND')
    await kernel.shutdown()
  })

  it('unloading revokes the service; consumers onAvailable notified, dispatch degrades', async () => {
    const { kernel, home } = bootKernel()
    homes.push(home)

    let notified = 0
    let resolvedIdentity = 'unset'
    const consumer: LedgerPlugin = definePlugin({
      manifest: { name: 'plugin-consumer', version: '0.0.1', isolation: 'inprocess', consumes: ['user'] },
      async activate(host) {
        const resolve = () => {
          const svc = host.services.get<{ getUserId(): string }>('user')
          resolvedIdentity = svc ? svc.getUserId() : 'me' // 降级：回退 me
          notified += 1
        }
        host.services.onAvailable('user', resolve)
        resolve()
      },
      async deactivate() {},
    })

    await kernel.loadPlugins([userPlugin, consumer])
    expect(resolvedIdentity).toBe('me')
    expect(notified).toBe(1)

    await kernel.pluginHost.unload('plugin-user')

    // 服务注销 + 观察方收到通知 + 重新 get 拿到 undefined → 降级 'me'
    expect(kernel.services.get('user')).toBeUndefined()
    expect(notified).toBe(2)
    expect(resolvedIdentity).toBe('me')

    // 统一调用协议明确报 SERVICE_UNAVAILABLE（而非静默）
    expect(await errCode(kernel, 'user.get')).toBe('SERVICE_UNAVAILABLE')
    expect(await errCode(kernel, 'user.list')).toBe('SERVICE_UNAVAILABLE')
    await kernel.shutdown()
  })

  it('without plugin-user, commands degrade explicitly; data flows keep recorder "me"', async () => {
    const { kernel, home } = bootKernel()
    homes.push(home)

    expect(await errCode(kernel, 'user.get')).toBe('SERVICE_UNAVAILABLE')

    const entry = await call(kernel, 'entry.add', { direction: 'expense', amountMinor: 100, currency: 'CNY' })
    expect((entry as { ok: true; data: any }).data.recorder).toBe('me')
    await kernel.shutdown()
  })

  it('activate without db service fails loudly (bad plugin must not hang the host)', async () => {
    const kernel = createKernel({
      repo: new InMemoryEntryRepository(),
      metaStore: new InMemoryMetadataStore(),
    })
    await expect(kernel.loadPlugins([userPlugin])).rejects.toThrow(/db/)
  })
})
