import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findProjectRoot, initializeProjectConfig, ProjectConfigStore } from './config.js'
import { createKernel } from './kernel.js'
import { InMemoryEntryRepository, InMemoryMetadataStore } from '@ledger/domain'
import { definePlugin } from '@ledger/plugin-contract'

const dirs: string[] = []

async function projectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-config-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('ProjectConfigStore', () => {
  it('finds a Git project root when a project has no pnpm workspace file', async () => {
    const root = await projectDir()
    const nested = join(root, 'packages', 'example')
    await mkdir(join(root, '.git'))
    await mkdir(nested, { recursive: true })

    expect(await findProjectRoot(nested)).toBe(root)
  })

  it('initializes an idempotent project-root config with .ledger storage by default', async () => {
    const root = await projectDir()

    const first = await initializeProjectConfig({ projectRoot: root })
    expect(first.created).toBe(true)
    expect(first.config.filePath).toBe(join(root, 'ledger.config.json'))
    expect(first.config.get('storage.dataDir')).toBe(join(root, '.ledger'))
    await first.config.close()

    const second = await initializeProjectConfig({ projectRoot: root })
    expect(second.created).toBe(false)
    await second.config.close()
  })

  it('loads repository-root config, resolves storage path, and exposes immutable snapshots', async () => {
    const root = await projectDir()
    await writeFile(
      join(root, 'ledger.config.json'),
      JSON.stringify({ storage: { dataDir: './var/ledger' }, plugins: { 'plugin-demo': { color: 'blue' } } }),
    )

    const config = await ProjectConfigStore.open({ projectRoot: root })

    expect(config.get('storage.dataDir')).toBe(join(root, 'var/ledger'))
    expect(config.get('plugins.plugin-demo.color')).toBe('blue')
    const snapshot = config.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.storage)).toBe(true)
    await config.close()
  })

  it('hot reloads valid changes and keeps the last valid snapshot on parse errors', async () => {
    const root = await projectDir()
    const file = join(root, 'ledger.config.json')
    await writeFile(file, JSON.stringify({ storage: { dataDir: './data' }, plugins: { demo: { port: 1 } } }))
    const config = await ProjectConfigStore.open({ projectRoot: root })
    const changed = vi.fn()
    config.subscribe('plugins.demo.port', changed, 'test-owner')

    await writeFile(file, JSON.stringify({ storage: { dataDir: './data' }, plugins: { demo: { port: 2 } } }))
    await config.reload()
    expect(config.get('plugins.demo.port')).toBe(2)
    expect(changed).toHaveBeenCalledWith(2, 1)

    await writeFile(file, '{ invalid')
    await expect(config.reload()).rejects.toThrow(/invalid config JSON/)
    expect(config.get('plugins.demo.port')).toBe(2)
    expect(config.status().lastError).toMatch(/invalid config JSON/)
    await config.close()
  })

  it('watches atomic file updates and publishes them without an explicit reload call', async () => {
    const root = await projectDir()
    const file = join(root, 'ledger.config.json')
    await writeFile(file, JSON.stringify({ storage: { dataDir: './data' }, plugins: { demo: { enabled: true } } }))
    const config = await ProjectConfigStore.open({ projectRoot: root, watch: true, debounceMs: 10 })

    await writeFile(file, JSON.stringify({ storage: { dataDir: './data' }, plugins: { demo: { enabled: false } } }))
    await waitFor(() => config.get('plugins.demo.enabled') === false)

    expect(config.get('plugins.demo.enabled')).toBe(false)
    await config.close()
  })

  it('marks startup-only storage changes as restart-required', async () => {
    const root = await projectDir()
    const file = join(root, 'ledger.config.json')
    await writeFile(file, JSON.stringify({ storage: { dataDir: './one' } }))
    const config = await ProjectConfigStore.open({ projectRoot: root })

    await writeFile(file, JSON.stringify({ storage: { dataDir: './two' } }))
    await config.reload()

    expect(config.status().restartRequired).toBe(true)
    expect(config.status().restartRequiredPaths).toContain('storage.dataDir')
    await config.close()
  })

  it('exposes only manifest-declared paths and publishes hot changes to plugins', async () => {
    const root = await projectDir()
    const file = join(root, 'ledger.config.json')
    await writeFile(file, JSON.stringify({ storage: { dataDir: './data' }, plugins: { demo: { port: 7400 } } }))
    const config = await ProjectConfigStore.open({ projectRoot: root })
    const kernel = createKernel({
      repo: new InMemoryEntryRepository(),
      metaStore: new InMemoryMetadataStore(),
      config: { configProvider: config },
    })
    const observed: number[] = []
    await kernel.loadPlugins([
      definePlugin({
        manifest: {
          name: 'plugin-demo',
          version: '0.1.0',
          isolation: 'inprocess',
          config: { reads: ['plugins.demo'] },
        },
        async activate(host) {
          observed.push(await host.config.require<number>('plugins.demo.port'))
          await expect(host.config.get('storage.dataDir')).rejects.toThrow(/did not declare/)
          host.config.subscribe('plugins.demo.port', (next) => observed.push(Number(next)))
        },
        async deactivate() {},
      }),
    ])

    await writeFile(file, JSON.stringify({ storage: { dataDir: './data' }, plugins: { demo: { port: 7500 } } }))
    await config.reload()
    expect(observed).toEqual([7400, 7500])
    await kernel.shutdown()
    await config.close()
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for config watcher')
}
