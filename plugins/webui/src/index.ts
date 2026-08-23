import { createServer, type Server } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, resolve, extname } from 'node:path'
import { definePlugin, type LedgerPlugin } from '@ledger/plugin-contract'
import { handleRpcRoute, sendJson } from '@ledger/http-rpc'
import { listUiPlugins, uiPluginsDirOf } from '@ledger/kernel'

/**
 * plugin-webui — L2 worker（前后端一体）：
 * - serve webui-shell 构建产物（本插件目录 shell/）
 * - API 网关：统一调用协议 over HTTP（复用 http-rpc）
 * - UI 插件文件服务：/plugins/<name>/* + /api/ui-plugins 清单
 * - supervisor 重引导：worker 崩溃由宿主拉起，浏览器侧重连
 */

const DEFAULT_PORT = 7420

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

async function serveFile(res: import('node:http').ServerResponse, absPath: string, fallbackType?: string): Promise<boolean> {
  let filePath = absPath
  try {
    const s = await stat(filePath)
    if (s.isDirectory()) filePath = join(filePath, 'index.html')
    await stat(filePath)
  } catch {
    return false
  }
  try {
    const content = await readFile(filePath)
    const type = MIME[extname(filePath)] ?? fallbackType ?? 'application/octet-stream'
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
    res.end(content)
    return true
  } catch {
    return false
  }
}

/** 防目录穿越：解析后的路径必须仍在 base 内 */
function safeJoin(base: string, relative: string): string | null {
  const rel = relative.replace(/^\/+/, '')
  const abs = resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + '/')) return null
  return abs
}

let activeServer: Server | undefined

export const webuiPlugin: LedgerPlugin = definePlugin({
  manifest: {
    name: 'plugin-webui',
    version: '0.1.0',
    isolation: 'worker',
    config: { reads: ['plugins.plugin-webui'] },
  },
  async activate(host) {
    const configuredPort = await host.config.get<number>('plugins.plugin-webui.port')
    const port = Number(configuredPort ?? process.env['LEDGER_WEBUI_PORT'] ?? DEFAULT_PORT)
    // shell 产物与本插件同目录（安装时随插件目录复制）
    const shellDir = process.env['LEDGER_WEBUI_SHELL_DIR'] ?? join(host.meta.dataDir, 'plugins', 'plugin-webui', 'shell')
    const uiPluginsDir = uiPluginsDirOf(host.meta.dataDir)

    const server = createServer(async (req, res) => {
      try {
        const url = (req.url ?? '/').split('?')[0]!

        if (await handleRpcRoute(req, res, (r) => host.dispatch(r), { defaultSource: 'webui' })) return

        if (req.method === 'GET' && url === '/api/ui-plugins') {
          const list = await listUiPlugins(host.meta.dataDir)
          sendJson(res, 200, list.map((p) => ({ name: p.name, version: p.version, entry: `/plugins/${p.name}/${p.entry.replace(/^\.\//, '')}` })))
          return
        }

        if (req.method === 'GET' && (url === '/api/health' || url === '/health')) {
          sendJson(res, 200, { ok: true, plugin: 'plugin-webui' })
          return
        }

        if (req.method === 'GET') {
          // UI 插件文件
          if (url.startsWith('/plugins/')) {
            const rel = url.slice('/plugins/'.length)
            const slash = rel.indexOf('/')
            if (slash > 0) {
              const name = rel.slice(0, slash)
              const filePath = safeJoin(uiPluginsDir, `${name}/${rel.slice(slash + 1)}`)
              if (filePath && (await serveFile(res, filePath))) return
            }
            sendJson(res, 404, { error: 'ui plugin file not found' })
            return
          }
          // shell 静态资源与 SPA 回退
          const staticPath = safeJoin(shellDir, url)
          if (staticPath && url !== '/' && (await serveFile(res, staticPath))) return
          const indexPath = safeJoin(shellDir, 'index.html')
          if (indexPath && (await serveFile(res, indexPath))) return
        }

        sendJson(res, 404, { ok: false, error: { code: 'COMMAND_NOT_FOUND', message: `no route: ${req.method} ${url}` } })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } })
      }
    })

    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen(port, '127.0.0.1', () => resolvePromise())
    })
    activeServer = server
    host.log.info(`plugin-webui listening on http://127.0.0.1:${port}`)
  },

  async deactivate() {
    const server = activeServer
    activeServer = undefined
    if (!server) return
    await new Promise<void>((resolvePromise) => {
      server.closeAllConnections?.()
      server.close(() => resolvePromise())
    })
  },
})
