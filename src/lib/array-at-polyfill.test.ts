import { afterEach, describe, expect, it } from 'vitest'
import { installArrayAtPolyfill } from './array-at-polyfill'

describe('installArrayAtPolyfill', () => {
  const originalAt = Array.prototype.at

  afterEach(() => {
    Object.defineProperty(Array.prototype, 'at', {
      value: originalAt,
      writable: true,
      enumerable: false,
      configurable: true,
    })
  })

  it('is a no-op when Array.prototype.at already exists', () => {
    expect(typeof Array.prototype.at).toBe('function')
    const before = Array.prototype.at
    installArrayAtPolyfill()
    expect(Array.prototype.at).toBe(before)
  })

  it('restores Array.prototype.at when missing (KODY-VIDEO-M)', () => {
    // Simulate the unsupported environment that hit Router init.
    Reflect.deleteProperty(Array.prototype, 'at')
    expect(typeof Array.prototype.at).toBe('undefined')

    installArrayAtPolyfill()

    expect(typeof Array.prototype.at).toBe('function')
    expect(['a', 'b', 'c'].at(-1)).toBe('c')
    expect(['a', 'b', 'c'].at(0)).toBe('a')
    expect(['a', 'b', 'c'].at(1)).toBe('b')
    expect(['a', 'b', 'c'].at(10)).toBe(undefined)
    expect(['a', 'b', 'c'].at(-10)).toBe(undefined)
    expect([].at(-1)).toBe(undefined)
  })

  it('matches native negative-index and truncates fractional indexes', () => {
    Reflect.deleteProperty(Array.prototype, 'at')
    installArrayAtPolyfill()

    const items = ['zero', 'one', 'two']
    expect(items.at(-2)).toBe('one')
    expect(items.at(1.9)).toBe('one')
    expect(items.at(-1.2)).toBe('two')
  })
})
