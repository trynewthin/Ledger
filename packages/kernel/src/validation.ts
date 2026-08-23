import { z } from 'zod'
import type { Direction } from '@ledger/domain'
import type { FieldDefRecord } from '@ledger/domain'
import { AppError } from './errors.js'

// ---------------------------------------------------------------------------
// 入口层格式校验（zod）：CLI flag / MCP tool schema / HTTP body 校验同源
// ---------------------------------------------------------------------------

const currency = z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code')

export const addEntrySchema = z.object({
  direction: z.enum(['income', 'expense']),
  amountMinor: z.number({ invalid_type_error: 'amountMinor must be a number' }).int().positive(),
  currency,
  type: z.string().min(1).nullable().optional(),
  occurredAt: z.number().optional(),
  extra: z.record(z.unknown()).optional(),
  strictExtra: z.boolean().optional(),
})

export const reviseEntrySchema = z.object({
  id: z.string().min(1),
  reason: z.string().nullable().optional(),
  strictExtra: z.boolean().optional(),
  patch: z
    .object({
      direction: z.enum(['income', 'expense']).optional(),
      amountMinor: z.number().int().positive().optional(),
      currency: currency.optional(),
      type: z.string().min(1).nullable().optional(),
      occurredAt: z.number().optional(),
      extra: z.record(z.unknown()).optional(),
    })
    .optional(),
})

export const voidEntrySchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1, 'void reason is required'),
})

export const listEntriesSchema = z.object({
  direction: z.enum(['income', 'expense']).optional(),
  type: z.string().nullable().optional(),
  recorder: z.string().optional(),
  from: z.number().optional(),
  to: z.number().optional(),
  includeVoided: z.boolean().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
})

export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, input: unknown, label: string): z.infer<T> {
  const result = schema.safeParse(input)
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    throw new AppError('VALIDATION_ERROR', `${label} validation failed`, issues)
  }
  return result.data
}

// ---------------------------------------------------------------------------
// extra 字段校验：已注册字段按定义校验；未注册键内核宽松不拒（数据自包含），
// 入口可选严格（strictExtra → FIELD_UNKNOWN）
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function validateExtraAgainstFields(
  extra: Record<string, unknown>,
  fields: FieldDefRecord[],
  opts: { direction?: Direction; strictExtra: boolean },
): void {
  const byKey = new Map(fields.map((f) => [f.key, f]))
  for (const [key, value] of Object.entries(extra)) {
    const def = byKey.get(key)
    if (!def) {
      if (opts.strictExtra) {
        throw new AppError('FIELD_UNKNOWN', `extra field "${key}" is not registered (--strict rejects unknown fields)`)
      }
      continue
    }
    if (opts.direction && def.scope !== 'both' && def.scope !== opts.direction) {
      throw new AppError(
        'FIELD_SCOPE_MISMATCH',
        `field "${key}" is scoped to ${def.scope}, not ${opts.direction}`,
      )
    }
    switch (def.valueType) {
      case 'string':
        if (typeof value !== 'string') throw fieldMismatch(key, 'string')
        break
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw fieldMismatch(key, 'number')
        break
      case 'boolean':
        if (typeof value !== 'boolean') throw fieldMismatch(key, 'boolean')
        break
      case 'date':
        if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
          throw fieldMismatch(key, 'date (YYYY-MM-DD)')
        }
        break
      case 'enum': {
        if (typeof value !== 'string') throw fieldMismatch(key, 'enum')
        const allowed = def.enumValues ?? []
        if (!allowed.some((ev) => ev.value === value)) {
          throw new AppError(
            'ENUM_VIOLATION',
            `extra field "${key}" value "${value}" not in enum: ${allowed.map((ev) => ev.value).join(' | ')}`,
          )
        }
        break
      }
    }
  }
}

function fieldMismatch(key: string, expected: string): AppError {
  return new AppError('FIELD_TYPE_MISMATCH', `extra field "${key}" must be ${expected}`)
}
