import { describe, expect, it } from 'vitest'
import { InMemoryEntryRepository, InMemoryMetadataStore } from '@ledger/domain'
import type { AdminHostAPI, HostAPI, LedgerPlugin } from '@ledger/plugin-contract'
import { definePlugin } from '@ledger/plugin-contract'
import { createKernel, type Kernel } from './kernel.js'

function makePlugin(name: string, opts: { provides?: string[]; consumes?: string[] } = {}): LedgerPlugin {
  return definePlugin({
    manifest: { name, version: '1.0.0', isolation: 'inprocess', ...opts },
    activate: async () => {},
    deactivate: async () => {},
  })
}

describe('plugin host', () => {
  it('loads plugins in provides→consumes topological order', async () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    const order: string[] = []
    const user = definePlugin({
      manifest: { name: 'plugin-user', version: '1', isolation: 'inprocess', provides: ['user'] },
      activate: async () => { order.push('user') },
      deactivate: async () => {},
    })
    const consumer = definePlugin({
      manifest: { name: 'plugin-consumer', version: '1', isolation: 'inprocess', consumes: ['user'] },
      activate: async () => { order.push('consumer') },
      deactivate: async () => {},
    })
    // 声明顺序故意反着来
    await kernel.loadPlugins([consumer, user])
    expect(order).toEqual(['user', 'consumer'])
  })

  it('missing optional dependency still loads (degrades, no cascade)', async () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    const orphan = definePlugin({
      manifest: { name: 'plugin-orphan', version: '1', isolation: 'inprocess', consumes: ['nonexistent'] },
      activate: async (host) => {
        expect(host.services.get('nonexistent')).toBeUndefined()
      },
      deactivate: async () => {},
    })
    await kernel.loadPlugins([orphan])
    expect(kernel.pluginHost.list().map((p) => p.name)).toContain('plugin-orphan')
  })

  it('deactivate auto-unregisters types/fields/events/services', async () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    let gotEvent = false
    const provider = definePlugin({
      manifest: { name: 'plugin-provider', version: '1', isolation: 'inprocess', provides: ['svc'] },
      activate: async (host) => {
        await host.registry.registerType({ key: 'p-type', label: '插件类型', direction: 'expense' })
        await host.registry.registerField({ key: 'p-field', label: '插件字段', scope: 'both', valueType: 'string' })
        host.services.provide('svc', { n: 1 })
        host.events.subscribe('EntryRecorded', () => { gotEvent = true })
      },
      deactivate: async () => {},
    })
    await kernel.loadPlugins([provider])
    expect(kernel.registry.getType('p-type')).toBeDefined()
    await kernel.dispatcher.dispatch({ command: 'entry.add', payload: { direction: 'expense', amountMinor: 1, currency: 'CNY' } })
    expect(gotEvent).toBe(true)

    await kernel.pluginHost.unload('plugin-provider')
    expect(kernel.registry.getType('p-type')).toBeUndefined()
    expect(kernel.registry.getField('p-field')).toBeUndefined()
    expect(kernel.services.get('svc')).toBeUndefined()
    expect(kernel.events.subscriberCount('EntryRecorded')).toBe(0)
    gotEvent = false
    await kernel.dispatcher.dispatch({ command: 'entry.add', payload: { direction: 'expense', amountMinor: 1, currency: 'CNY' } })
    expect(gotEvent).toBe(false)
  })

  it('crashed deactivate marks registrations unavailable (data stays)', async () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    const bad = definePlugin({
      manifest: { name: 'plugin-bad', version: '1', isolation: 'inprocess' },
      activate: async (host) => {
        await host.registry.registerType({ key: 'bad-type', label: '坏类型', direction: 'expense' })
      },
      deactivate: async () => { throw new Error('cleanup failed') },
    })
    await kernel.loadPlugins([bad])
    expect(kernel.registry.getType('bad-type')).toBeDefined()
    await kernel.pluginHost.unload('plugin-bad', 'crash')
    // 注册项保留但标记不可用
    expect(kernel.registry.getType('bad-type')).toBeDefined()
    expect(kernel.registry.listTypes({ includeUnavailable: true }).find((t) => t.key === 'bad-type')?.unavailable).toBe(true)
  })

  it('admin whitelist: only coreMaintainedPlugins get AdminHostAPI', async () => {
    const kernel = createKernel({
      repo: new InMemoryEntryRepository(),
      metaStore: new InMemoryMetadataStore(),
      config: { coreMaintainedPlugins: ['plugin-cli'] },
    })
    let cliApi: HostAPI | AdminHostAPI | undefined
    let normalApi: HostAPI | AdminHostAPI | undefined
    const cli = definePlugin({
      manifest: { name: 'plugin-cli', version: '1', isolation: 'inprocess', capabilities: ['admin'] },
      activate: async (host) => { cliApi = host },
      deactivate: async () => {},
    })
    const normal = makePlugin('plugin-normal')
    const origActivate = normal.activate
    normal.activate = async (host) => { normalApi = host; await origActivate(host) }
    await kernel.loadPlugins([cli, normal])
    expect(cliApi && 'plugins' in cliApi).toBe(true)
    expect(normalApi && 'plugins' in normalApi).toBe(false)
    // 白名单外的 admin 声明无效
    const fake = definePlugin({
      manifest: { name: 'plugin-fake', version: '1', isolation: 'inprocess', capabilities: ['admin'] },
      activate: async (host) => { normalApi = host },
      deactivate: async () => {},
    })
    await kernel.loadPlugins([fake])
    expect('plugins' in normalApi!).toBe(false)
  })

  it('activate failure rejects the plugin and cleans up', async () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    const broken = definePlugin({
      manifest: { name: 'plugin-broken', version: '1', isolation: 'inprocess' },
      activate: async () => { throw new Error('cannot start') },
      deactivate: async () => {},
    })
    await expect(kernel.loadPlugins([broken])).rejects.toThrow(/PLUGIN_ACTIVATE_FAILED|cannot start/)
    expect(kernel.pluginHost.list().find((p) => p.name === 'plugin-broken')).toBeUndefined()
  })

  it('worker isolation plugins are rejected by the in-proc host', async () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    const workerPlugin = definePlugin({
      manifest: { name: 'plugin-worker-x', version: '1', isolation: 'worker' },
      activate: async () => {},
      deactivate: async () => {},
    })
    await expect(kernel.loadPlugins([workerPlugin])).rejects.toThrow(/worker isolation/)
  })
})
