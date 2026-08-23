import { describe, expect, it } from 'vitest'
import { InMemoryEntryRepository, InMemoryMetadataStore } from '@ledger/domain'
import { definePlugin } from '@ledger/plugin-contract'
import { ProjectInitializationRegistry } from './initialization.js'
import { createKernel } from './kernel.js'

describe('project initialization lifecycle', () => {
  it('runs registered initializers in registration order and reports their names', async () => {
    const lifecycle = new ProjectInitializationRegistry('/tmp/project')
    const seen: string[] = []
    lifecycle.register('storage', 'core', async () => { seen.push('storage') })
    lifecycle.register('demo-seed', 'plugin-demo', async () => { seen.push('plugin') })

    expect(await lifecycle.run()).toEqual(['storage', 'demo-seed'])
    expect(seen).toEqual(['storage', 'plugin'])
  })

  it('lets an in-process plugin extend initialization through HostAPI', async () => {
    const lifecycle = new ProjectInitializationRegistry('/tmp/project')
    const kernel = createKernel({
      repo: new InMemoryEntryRepository(),
      metaStore: new InMemoryMetadataStore(),
      config: { initializationProvider: lifecycle },
    })
    const seen: string[] = []

    await kernel.loadPlugins([
      definePlugin({
        manifest: { name: 'plugin-demo', version: '0.1.0', isolation: 'inprocess' },
        async activate(host) {
          host.initialization.register('seed', async () => { seen.push(host.initialization.projectRoot) })
        },
        async deactivate() {},
      }),
    ])

    await lifecycle.run()
    expect(seen).toEqual(['/tmp/project'])
    await kernel.shutdown()
  })
})
