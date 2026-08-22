import { describe, expect, it } from 'vitest'
import { defineUiPlugin } from './index.js'

describe('webui-contract runtime', () => {
  it('defineUiPlugin passes through', () => {
    const p = defineUiPlugin({
      manifest: { name: 'webui-x', version: '1.0.0' },
      activate: async () => {},
      deactivate: async () => {},
    })
    expect(p.manifest.name).toBe('webui-x')
  })
})
