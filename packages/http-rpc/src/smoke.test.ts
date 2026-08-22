import { describe, expect, it } from 'vitest'
import { pkg } from './index.js'

describe('smoke', () => {
  it('package loads', () => {
    expect(pkg.name).toContain('@ledger/')
  })
})
