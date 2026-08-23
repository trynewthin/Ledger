import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connect } from 'node:net'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHost, type HostHandle } from '@ledger/host'
import { ProjectConfigStore } from '@ledger/kernel'

const exec = promisify(execFile)
const REPO = resolve(__dirname, '../../..')
const HTTP_PORT = 7421

/** 轻量 socket RPC 客户端（测试内联版，与 plugins/cli 的实现同一协议） */
function rpcCall(sockPath: string, req: Record<string, unknown>): Promise<any> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect(sockPath)
    socket.setTimeout(3000)
    let buf = ''
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, ...req }) + '\n'))
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const idx = buf.indexOf('\n')
      if (idx >= 0) {
        resolvePromise(JSON.parse(buf.slice(0, idx)))
        socket.destroy()
      }
    })
    socket.on('error', rejectPromise)
    socket.on('timeout', () => {
      rejectPromise(new Error('rpc timeout'))
      socket.destroy()
    })
  })
}

function rpcConnectable(sockPath: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect(sockPath)
    socket.setTimeout(300)
    socket.once('connect', () => {
      socket.destroy()
      resolvePromise(true)
    })
    socket.once('error', () => resolvePromise(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolvePromise(false)
    })
  })
}

let home: string
let handle: HostHandle
let config: ProjectConfigStore

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'ledger-host-'))
  writeFileSync(
    join(home, 'ledger.config.json'),
    JSON.stringify({ storage: { dataDir: home }, plugins: { 'plugin-http': { port: HTTP_PORT } } }),
  )
  config = await ProjectConfigStore.open({ projectRoot: home, watch: true, debounceMs: 10 })
})
afterAll(async () => {
  await handle?.shutdown().catch(() => undefined)
  rmSync(home, { recursive: true, force: true })
})

async function dispatch(command: string, payload?: unknown, context?: Record<string, string>) {
  return handle.kernel.dispatcher.dispatch({ command, payload, context })
}

function dataOf(res: { ok: boolean; data?: unknown; error?: unknown }): any {
  if (!res.ok) throw new Error(`dispatch failed: ${JSON.stringify(res.error)}`)
  return res.data
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8000, interval = 150): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error('waitFor timed out')
}

async function httpOk(path: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}${path}`)
    return res.ok
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function rpc(command: string, payload?: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, payload, context: { source: 'http', recorder: 'me' } }),
  })
  return { status: res.status, body: (await res.json()) as any }
}

async function rest(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as any }
}

function writePlugin(dir: string, source: string, manifest?: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.mjs'), source)
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify(manifest ?? { name: 'plugin-demo', main: './index.mjs', isolation: 'inprocess' }),
  )
}

describe('resident host', () => {
  it('starts, serves socket RPC, and reports host.info', async () => {
    handle = await startHost({ home, configProvider: config })
    expect(handle.socketPath).toContain('host.sock')

    const info = await rpcCall(handle.socketPath, { command: 'host.info', context: { source: 'cli' } })
    expect(info.result.ok).toBe(true)
    expect(info.result.data.pid).toBe(process.pid)
    expect(info.result.data.name).toBe('ledger-host')

    const added = await rpcCall(handle.socketPath, {
      command: 'entry.add',
      payload: { direction: 'expense', amountMinor: 1250, currency: 'CNY' },
      context: { source: 'cli', recorder: 'me' },
    })
    expect(added.result.ok).toBe(true)
    expect(added.result.data.source).toBe('cli')
  })

  it('Book Core switches complete state without loading a snapshot plugin', async () => {
    const before = dataOf(await dispatch('entry.list', { includeVoided: true })).total
    const created = dataOf(await dispatch('book.create', { name: 'host-switch' }))
    expect(created.name).toBe('host-switch')

    await dispatch('entry.add', { direction: 'expense', amountMinor: 7, currency: 'CNY' })
    expect(dataOf(await dispatch('entry.list', { includeVoided: true })).total).toBe(before + 1)

    const switched = dataOf(await dispatch('book.switch', { id: created.id }))
    expect(switched.book.id).toBe(created.id)
    expect(dataOf(await dispatch('entry.list', { includeVoided: true })).total).toBe(before)

    const currentDelete = await dispatch('book.delete', { id: created.id })
    expect(currentDelete).toMatchObject({ ok: false, error: { code: 'BOOK_ACTIVE' } })
  })

  it('CLI hybrid mode prefers RPC when host is alive', { timeout: 30_000 }, async () => {
    const { stdout } = await exec(
      'node',
      [join(REPO, 'plugins/cli/dist/cli.js'), 'add', '-d', 'income', '-a', '99.99', '--json'],
      { env: { ...process.env, LEDGER_HOME: home } },
    )
    const entry = JSON.parse(stdout)
    expect(entry.source).toBe('cli')
    // 经由宿主内核验证（说明走了 RPC 而非冷引导本地组装）
    const list = await dispatch('entry.list', { recorder: 'me' })
    expect(dataOf(list).total).toBeGreaterThanOrEqual(2)
  })

  it('L1 hot reload: picks up new version; failed reload rolls back to old one', { timeout: 30_000 }, async () => {
    const dir = join(home, 'src-demo-plugin')
    const v1 = `export default {
      manifest: { name: 'plugin-demo', version: '1.0.0', isolation: 'inprocess' },
      async activate(host) { await host.registry.registerType({ key: 'demo', label: 'v1', direction: 'expense' }) },
      async deactivate() {},
    }`
    writePlugin(dir, v1)
    await handle.plugins.install(dir)
    await handle.plugins.load('plugin-demo')

    const t1 = dataOf(await dispatch('type.get', { key: 'demo' }))
    expect(t1.label).toBe('v1')

    // v2: 重新安装（拷贝更新）后热替换生效
    const v2 = v1
      .replace("'1.0.0'", "'2.0.0'")
      .replace("'v1'", "'v2'")
    writePlugin(dir, v2)
    await handle.plugins.install(dir)
    await handle.plugins.reload('plugin-demo')
    const t2 = dataOf(await dispatch('type.get', { key: 'demo' }))
    expect(t2.label).toBe('v2')
    const info = (await handle.plugins.list()).find((p) => p.name === 'plugin-demo')
    expect(info?.version).toBe('2.0.0')

    // v3: activate 抛错 → 自动回滚 v2
    const v3 = v1
      .replace("'1.0.0'", "'3.0.0'")
      .replace("await host.registry.registerType({ key: 'demo', label: 'v1', direction: 'expense' })", 'throw new Error("broken v3")')
    writePlugin(dir, v3)
    await handle.plugins.install(dir)
    await expect(handle.plugins.reload('plugin-demo')).rejects.toThrow(/rolled back/)
    const t3 = dataOf(await dispatch('type.get', { key: 'demo' }))
    expect(t3.label).toBe('v2') // 旧版本仍在服役
    const info3 = (await handle.plugins.list()).find((p) => p.name === 'plugin-demo')
    expect(info3?.version).toBe('2.0.0')
    expect(info3?.state).toBe('active')
  })

  it('L2 supervisor: killed worker restarts automatically, host survives', { timeout: 40_000 }, async () => {
    const dir = join(home, 'src-worker-demo')
    writePlugin(
      dir,
      `export default {
        manifest: { name: 'plugin-worker-demo', version: '1.0.0', isolation: 'worker' },
        async activate(host) {
          await host.ledger.addEntry({ direction: 'expense', amountMinor: 1, currency: 'CNY' })
        },
        async deactivate() {},
      }`,
      { name: 'plugin-worker-demo', main: './index.mjs', isolation: 'worker' },
    )
    await handle.plugins.install(dir)
    await handle.plugins.load('plugin-worker-demo')

    const count1 = dataOf(await dispatch('entry.list', {})).total
    expect(count1).toBeGreaterThanOrEqual(1)

    // 强杀 worker：宿主存活，自动退避拉起（重激活会再记一笔）
    handle.supervisor.forceKill('plugin-worker-demo')
    await waitFor(async () => {
      const count = dataOf(await dispatch('entry.list', {})).total
      return count > count1
    }, 20_000)
    const count2 = dataOf(await dispatch('entry.list', {})).total
    expect(count2).toBeGreaterThan(count1)
    // 宿主与既有插件仍然存活
    const info = await dispatch('host.info', {})
    expect(info.ok).toBe(true)
    const demoType = await dispatch('type.get', { key: 'demo' })
    expect(demoType.ok).toBe(true)
  })

  it('plugin-http (L2): serves unified protocol; killed worker auto-restarts', { timeout: 60_000 }, async () => {
    await handle.plugins.install(join(REPO, 'plugins/http'))
    await handle.plugins.load('plugin-http')

    await waitFor(() => httpOk('/health'))

    const added = await rpc('entry.add', { direction: 'expense', amountMinor: 500, currency: 'CNY' })
    expect(added.status).toBe(200)
    expect(added.body.ok).toBe(true)
    expect(added.body.data.source).toBe('http')

    const notFound = await rpc('no.such.command')
    expect(notFound.status).toBe(404)
    expect(notFound.body.error.code).toBe('COMMAND_NOT_FOUND')

    const badPayload = await rpc('entry.add', { direction: 'both', amountMinor: 1, currency: 'CNY' })
    expect(badPayload.status).toBe(400)
    expect(badPayload.body.error.code).toBe('VALIDATION_ERROR')

    // HTTP 保持资源语义，内部仍汇聚到同一个 entry.* 应用命令。
    const restAdded = await rest('POST', '/entries', { direction: 'expense', amountMinor: 880, currency: 'CNY' })
    expect(restAdded.status).toBe(201)
    expect(restAdded.body.data.source).toBe('http')
    const restId = restAdded.body.data.id

    const restList = await rest('GET', '/entries?direction=expense&limit=1')
    expect(restList.status).toBe(200)
    expect(restList.body.data.items).toHaveLength(1)

    const capabilities = await rest('GET', '/capabilities')
    expect(capabilities.body.data.some((item: any) => item.name === 'entry.add')).toBe(true)

    const badQuery = await rest('GET', '/entries?limit=not-a-number')
    expect(badQuery.status).toBe(400)
    expect(badQuery.body.error.code).toBe('VALIDATION_ERROR')

    const restGet = await rest('GET', `/entries/${restId}`)
    expect(restGet.body.data.id).toBe(restId)

    const restRevise = await rest('PATCH', `/entries/${restId}`, { patch: { amountMinor: 990 }, reason: '更正' })
    expect(restRevise.body.data.amountMinor).toBe(990)

    const restVoid = await rest('POST', `/entries/${restId}/void`, { reason: '测试作废' })
    expect(restVoid.body.data.voidedAt).not.toBeNull()

    // 杀掉 HTTP worker：宿主存活并自动拉起
    handle.supervisor.forceKill('plugin-http')
    await sleep(1200)
    const infoDuringCrash = await dispatch('host.info', {})
    expect(infoDuringCrash.ok).toBe(true) // 宿主存活
    await waitFor(() => httpOk('/health'), 15_000)
    const after = await rpc('entry.list', {})
    expect(after.status).toBe(200)
    expect(after.body.ok).toBe(true)

    // L2 reload = worker 重引导
    const reloaded = await dispatch('plugin.reload', { name: 'plugin-http' })
    expect(reloaded.ok).toBe(true)
    await waitFor(() => httpOk('/health'), 15_000)
  })

  it('shuts down cleanly, removing the socket file', { timeout: 30_000 }, async () => {
    const sock = handle.socketPath
    await handle.shutdown()
    expect(existsSync(sock)).toBe(false)
    expect(await rpcConnectable(sock)).toBe(false)
  })
})
