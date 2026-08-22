import { describe, expect, it } from 'vitest'
import { statusForErrorCode } from './index.js'

describe('http-rpc error model mapping', () => {
  it('maps typed error codes to statuses', () => {
    expect(statusForErrorCode('COMMAND_NOT_FOUND')).toBe(404)
    expect(statusForErrorCode('ENTRY_NOT_FOUND')).toBe(404)
    expect(statusForErrorCode('VALIDATION_ERROR')).toBe(400)
    expect(statusForErrorCode('INVALID_AMOUNT')).toBe(400)
    expect(statusForErrorCode('ENUM_VIOLATION')).toBe(400)
    expect(statusForErrorCode('TYPE_DIRECTION_MISMATCH')).toBe(400)
    expect(statusForErrorCode('ENTRY_VOIDED')).toBe(409)
    expect(statusForErrorCode('FORBIDDEN')).toBe(403)
    expect(statusForErrorCode('NOT_SUPPORTED')).toBe(501)
    expect(statusForErrorCode('INTERNAL')).toBe(500)
    expect(statusForErrorCode('SOMETHING_NEW')).toBe(500)
  })
})
