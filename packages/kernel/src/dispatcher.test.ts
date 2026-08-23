import { describe, expect, it } from 'vitest'
import { Dispatcher } from './dispatcher.js'

describe('Dispatcher capability catalog', () => {
  it('registers command behavior together with protocol-specific discovery metadata', async () => {
    const dispatcher = new Dispatcher()
    dispatcher.register(
      {
        name: 'entry.demo',
        domain: 'entry',
        action: 'demo',
        description: '演示领域命令',
        exposure: {
          cli: { command: 'demo' },
          http: { method: 'POST', path: '/entries/demo' },
          mcp: { tool: 'demo_entry' },
        },
      },
      (payload) => ({ echoed: payload }),
    )

    expect(dispatcher.describeCommands()).toEqual([
      expect.objectContaining({
        name: 'entry.demo',
        domain: 'entry',
        action: 'demo',
        exposure: expect.objectContaining({
          http: { method: 'POST', path: '/entries/demo' },
        }),
      }),
    ])
    expect(await dispatcher.dispatch({ command: 'entry.demo', payload: { value: 1 } })).toEqual({
      ok: true,
      data: { echoed: { value: 1 } },
    })
  })

  it('keeps legacy name-only registration discoverable for internal extensions', () => {
    const dispatcher = new Dispatcher()
    dispatcher.register('internal.demo', () => undefined)

    expect(dispatcher.describeCommands()).toEqual([
      expect.objectContaining({ name: 'internal.demo', domain: 'internal', action: 'demo' }),
    ])
  })
})
