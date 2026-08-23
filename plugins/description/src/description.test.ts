import { describe, expect, it } from 'vitest'
import { InMemoryEntryRepository, InMemoryMetadataStore } from '@ledger/domain'
import { createKernel } from '@ledger/kernel'
import { descriptionPlugin } from './index.js'

async function call(kernel: ReturnType<typeof createKernel>, command: string, payload?: unknown) {
  return kernel.dispatcher.dispatch({ command, payload, context: { source: 'test' } })
}

async function ok<T = unknown>(kernel: ReturnType<typeof createKernel>, command: string, payload?: unknown): Promise<T> {
  const result = await call(kernel, command, payload)
  if (!result.ok) throw new Error(`${command} failed: ${JSON.stringify(result.error)}`)
  return result.data as T
}

describe('plugin-description', () => {
  it('registers a shared description field and preserves values on entries', async () => {
    const kernel = createKernel({ repo: new InMemoryEntryRepository(), metaStore: new InMemoryMetadataStore() })
    await kernel.loadPlugins([descriptionPlugin])

    expect(await ok(kernel, 'field.list')).toMatchObject([
      { key: 'description', label: '描述', scope: 'both', valueType: 'string' },
    ])
    const added = await call(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 2500, currency: 'CNY', extra: { description: '周末采购' },
    })
    expect(added).toMatchObject({ ok: true, data: { extra: { description: '周末采购' } } })

    const invalid = await call(kernel, 'entry.add', {
      direction: 'expense', amountMinor: 100, currency: 'CNY', extra: { description: 42 },
    })
    expect(invalid).toMatchObject({ ok: false, error: { code: 'FIELD_TYPE_MISMATCH' } })

    await kernel.pluginHost.unload('plugin-description')
    expect(await ok(kernel, 'field.list')).toEqual([])
    expect(await call(kernel, 'entry.get', { id: (added as { ok: true; data: { id: string } }).data.id })).toMatchObject({
      ok: true,
      data: { extra: { description: '周末采购' } },
    })
  })
})
