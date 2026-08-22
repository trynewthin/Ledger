export type Direction = 'income' | 'expense'

export const DIRECTIONS: readonly Direction[] = ['income', 'expense']

export function isDirection(value: unknown): value is Direction {
  return value === 'income' || value === 'expense'
}
