import { describe, expect, it } from 'vitest'
import { clipIdAfterDelete } from './clip-selection'

describe('clipIdAfterDelete', () => {
  it('selects the previous clip when one remains before the deleted one', () => {
    expect(clipIdAfterDelete(['a', 'b', 'c'], 'b')).toBe('a')
    expect(clipIdAfterDelete(['a', 'b', 'c'], 'c')).toBe('b')
  })

  it('selects the next clip when the first clip is deleted', () => {
    expect(clipIdAfterDelete(['a', 'b', 'c'], 'a')).toBe('b')
  })

  it('returns null when the only clip is deleted', () => {
    expect(clipIdAfterDelete(['a'], 'a')).toBeNull()
  })

  it('falls back to the last clip when the deleted id is already gone', () => {
    expect(clipIdAfterDelete(['a', 'b'], 'missing')).toBe('b')
    expect(clipIdAfterDelete([], 'a')).toBeNull()
  })
})
