import { describe, expect, it } from 'vitest'
import { InMemoryEntryRepository, InMemoryMetadataStore } from '@ledger/domain'
import { createKernel, type Kernel } from './kernel.js'

async function ok<T = any>(kernel: Kernel, command: string, payload?: unknown): Promise<T> {
  const res = await kernel.dispatcher.dispatch({ command, payload, context: { source: 'cli' } })
  if (!res.ok) throw new Error(`${command} failed: ${JSON.stringify(res.error)}`)
  return res.data as T
}

describe('event bus', () => {
  it('delivers events and unsubscribes by owner', () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    const seen: string[] = []
    kernel.events.subscribe('EntryRecorded', () => seen.push('a'), 'plugin-a')
    kernel.events.subscribe('EntryRecorded', () => seen.push('b'), 'plugin-b')
    kernel.events.emit('EntryRecorded', {})
    expect(seen).toEqual(['a', 'b'])
    kernel.events.unsubscribeOwner('plugin-a')
    kernel.events.emit('EntryRecorded', {})
    expect(seen).toEqual(['a', 'b', 'b'])
  })

  it('handler errors do not break other subscribers', () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    let called = false
    kernel.events.subscribe('X', () => { throw new Error('boom') })
    kernel.events.subscribe('X', () => { called = true })
    kernel.events.emit('X', {})
    expect(called).toBe(true)
  })
})

describe('services', () => {
  it('provide/get and revokeOwner notify watchers', () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    const svc = { userId: 'me' }
    kernel.services.provide('user', svc, 'plugin-user')
    expect(kernel.services.get('user')).toBe(svc)

    const events: string[] = []
    kernel.services.onAvailable('user', () => {
      events.push(kernel.services.get('user') ? 'ready' : 'gone')
    }, 'plugin-consumer')

    kernel.services.revokeOwner('plugin-user')
    expect(events).toEqual(['gone'])
    expect(kernel.services.get('user')).toBeUndefined()

    kernel.services.provide('user', { userId: 'me2' }, 'plugin-user')
    expect(events).toEqual(['gone', 'ready'])
    expect(kernel.services.get<{ userId: string }>('user')!.userId).toBe('me2')
  })
})

describe('command capability discovery', () => {
  it('describes shared application commands and their natural protocol bindings', async () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    const descriptors = await ok<any[]>(kernel, 'commands.describe')
    const add = descriptors.find((item) => item.name === 'entry.add')

    expect(add).toMatchObject({
      domain: 'entry',
      action: 'add',
      exposure: {
        cli: { command: 'add' },
        http: { method: 'POST', path: '/entries' },
        mcp: { tool: 'add_entry' },
      },
      inputSchema: expect.objectContaining({ required: ['direction', 'amountMinor', 'currency'] }),
    })
  })
})

describe('registry unavailable marking', () => {
  it('marks owner unavailable instead of silently dropping', async () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    await ok(kernel, 'type.register', { key: 'food', label: '餐饮', direction: 'expense' })
    kernel.pluginHost.deps.registry.registerType(
      { key: 'plugin-type', label: '插件类型', direction: 'expense' },
      { origin: 'plugin', owner: 'plugin-x' },
    )
    // 模拟提供者崩溃：注册项保留但标记不可用
    kernel.registry.markOwnerUnavailable('plugin-x')
    const marked = (await ok(kernel, 'type.list', {})).find((t: any) => t.key === 'plugin-type')
    expect(marked.unavailable).toBe(true)
    const healthy = (await ok(kernel, 'type.list', {})).find((t: any) => t.key === 'food')
    expect(healthy.unavailable).toBe(false)
    // 校验视角：unavailable = 不可用
    expect(kernel.registry.effectiveType('plugin-type')).toBeUndefined()
    expect(kernel.registry.effectiveType('food')).toBeDefined()
    // 恢复
    kernel.registry.markOwnerAvailable('plugin-x')
    expect(kernel.registry.effectiveType('plugin-type')).toBeDefined()
  })
})
