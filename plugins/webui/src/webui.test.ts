import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHost, type HostHandle } from '@ledger/host'
import { installUiPluginDir, uninstallUiPluginDir } from '@ledger/kernel'

const REPO = resolve(__dirname, '../../..')
process.env['LEDGER_WEBUI_PORT'] = '7431'
const PORT = 7431
const base = `http://127.0.0.1:${PORT}`

let home: string
let handle: HostHandle

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'ledger-webui-'))
})
afterAll(async () => {
  await handle?.shutdown().catch(() => undefined)
  rmSync(home, { recursive: true, force: true })
})

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20000, interval = 150): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error('waitFor timed out')
}

async function get(path: string): Promise<{ status: number; text: string; json?: any }> {
  const res = await fetch(base + path)
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    // 非 JSON
  }
  return { status: res.status, text, json }
}

async function rpc(command: string, payload?: unknown): Promise<any> {
  const res = await fetch(base + '/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, payload, context: { source: 'webui', recorder: 'me' } }),
  })
  return { status: res.status, body: (await res.json()) as any }
}

describe('plugin-webui (L2) — 分形插件架构', () => {
  it(
    'empty shell runs with zero UI plugins; shell assets served',
    { timeout: 60_000 },
    async () => {
      handle = await startHost({ home })
      await handle.plugins.install(join(REPO, 'plugins/webui'))
      await handle.plugins.load('plugin-webui')

      await waitFor(async () => (await get('/api/health')).status === 200)

      // 空 shell 零 UI 插件可运行
      const manifest = await get('/api/ui-plugins')
      expect(manifest.status).toBe(200)
      expect(manifest.json).toEqual([])

      const index = await get('/')
      expect(index.status).toBe(200)
      expect(index.text).toContain('importmap')
      expect(index.text).toContain('id="root"')

      const vendor = await get('/vendor/react.js')
      expect(vendor.status).toBe(200)
      expect(vendor.text).toContain('createElement')

      const spa = await get('/some/spa/route')
      expect(spa.status).toBe(200)
      expect(spa.text).toContain('id="root"')
    },
  )

  it(
    'installing webui-core-views exposes it; UI plugin ESM served with bare react imports',
    { timeout: 30_000 },
    async () => {
      const installed = await installUiPluginDir(join(REPO, 'plugins/webui-core-views/dist'), home)
      expect(installed.name).toBe('webui-core-views')

      const manifest = await get('/api/ui-plugins')
      expect(manifest.json).toEqual([
        { name: 'webui-core-views', version: '0.1.0', entry: '/plugins/webui-core-views/index.js' },
      ])

      const esm = await get('/plugins/webui-core-views/index.js')
      expect(esm.status).toBe(200)
      // 裸导入 react 经 shell 的 import map 解析（浏览器内共享单副本）
      expect(esm.text).toContain('from "react"')
      expect(esm.text).toContain('webui-core-views')

      // 目录穿越防护：原生客户端发送原始 ../ 路径（fetch 会预先折叠）
      const evilStatus = await new Promise<number>((resolvePromise) => {
        const req = http.request(
          { host: '127.0.0.1', port: PORT, path: '/plugins/webui-core-views/../../ledger.db' },
          (res) => {
            res.resume()
            res.on('end', () => resolvePromise(res.statusCode ?? 0))
          },
        )
        req.end()
      })
      expect(evilStatus).toBe(404)
    },
  )

  it(
    'API gateway speaks the unified protocol; dynamic field registration feeds the form (same source)',
    { timeout: 30_000 },
    async () => {
      // 注册枚举字段 → 表单（AddPage 从 field.list 驱动）自动出现新控件
      const reg = await rpc('field.register', {
        key: 'payment_platform',
        label: '付款平台',
        scope: 'both',
        valueType: 'enum',
        enumValues: [
          { value: 'alipay', label: '支付宝' },
          { value: 'wechat', label: '微信' },
        ],
      })
      expect(reg.body.ok).toBe(true)

      const fields = await rpc('field.list', {})
      expect(fields.body.data.find((f: any) => f.key === 'payment_platform')).toBeDefined()

      const added = await rpc('entry.add', {
        direction: 'expense',
        amountMinor: 2500,
        currency: 'CNY',
        extra: { payment_platform: 'alipay' },
      })
      expect(added.status).toBe(200)
      expect(added.body.data.source).toBe('webui') // source 由网关注入
      expect(added.body.data.extra).toEqual({ payment_platform: 'alipay' })

      // 错误模型 → HTTP status
      const bad = await rpc('entry.add', { direction: 'both', amountMinor: 1, currency: 'CNY' })
      expect(bad.status).toBe(400)
      expect(bad.body.error.code).toBe('VALIDATION_ERROR')
    },
  )

  it(
    'uninstalling the UI plugin removes it from the manifest (启停即时生效的服务端面)',
    { timeout: 20_000 },
    async () => {
      await uninstallUiPluginDir('webui-core-views', home)
      const manifest = await get('/api/ui-plugins')
      expect(manifest.json).toEqual([])
    },
  )

  it(
    'installing dataviews exposes data-view widgets; widget ESM served; stats feed over API',
    { timeout: 30_000 },
    async () => {
      const installed = await installUiPluginDir(join(REPO, 'plugins/dataviews/dist'), home)
      expect(installed.name).toBe('dataviews')

      const manifest = await get('/api/ui-plugins')
      expect(manifest.json).toEqual([{ name: 'dataviews', version: '0.1.0', entry: '/plugins/dataviews/index.js' }])

      const esm = await get('/plugins/dataviews/index.js')
      expect(esm.status).toBe(200)
      expect(esm.text).toContain('registerWidget')
      expect(esm.text).toContain('dataviews')

      // 概览页 widget 的数据命令面经 API 网关可用（含新 stats.byRecorder）
      const monthly = await rpc('stats.monthly', {})
      expect(monthly.status).toBe(200)
      expect(monthly.body.ok).toBe(true)

      const byRecorder = await rpc('stats.byRecorder', {})
      expect(byRecorder.status).toBe(200)
      expect(byRecorder.body.data.some((r: any) => r.recorder === 'me')).toBe(true)
    },
  )

  it(
    'killed webui worker restarts automatically; browser reconnects (health recovers)',
    { timeout: 60_000 },
    async () => {
      handle.supervisor.forceKill('plugin-webui')
      await new Promise((r) => setTimeout(r, 1000))
      const info = await handle.kernel.dispatcher.dispatch({ command: 'host.info' })
      expect(info.ok).toBe(true) // 宿主存活
      await waitFor(async () => (await get('/api/health')).status === 200, 30_000)
      const again = await rpc('entry.list', {})
      expect(again.status).toBe(200)
      expect(again.body.ok).toBe(true)
    },
  )
})
