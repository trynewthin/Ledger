import { describe, expect, it } from 'vitest'
import { definePlugin, isAdminHost, type HostAPI } from './index.js'

describe('plugin-contract runtime', () => {
  it('definePlugin passes the plugin through', () => {
    const plugin = definePlugin({
      manifest: { name: 'plugin-x', version: '1.0.0', isolation: 'inprocess' },
      activate: async () => {},
      deactivate: async () => {},
    })
    expect(plugin.manifest.name).toBe('plugin-x')
  })

  it('isAdminHost distinguishes capability faces', () => {
    const base = {} as HostAPI
    expect(isAdminHost(base)).toBe(false)
    expect(isAdminHost({ ...base, plugins: {}, host: {} } as never)).toBe(true)
  })
})
