import { describe, expect, it } from 'vitest'
import { formatBytes, formatStoragePercent, storageSeverity } from './storage-space'

describe('storageSeverity', () => {
  it('is ok below 80%', () => {
    expect(storageSeverity(0)).toBe('ok')
    expect(storageSeverity(0.79)).toBe('ok')
  })

  it('warns from 80%', () => {
    expect(storageSeverity(0.8)).toBe('warning')
    expect(storageSeverity(0.91)).toBe('warning')
  })

  it('is critical from 92%', () => {
    expect(storageSeverity(0.92)).toBe('critical')
    expect(storageSeverity(1)).toBe('critical')
  })
})

describe('formatBytes', () => {
  it('formats megabytes below 1GB', () => {
    expect(formatBytes(500 * 1024 * 1024)).toBe('500 MB')
    expect(formatBytes(1024)).toBe('1 MB')
  })

  it('formats gigabytes with one decimal under 10GB', () => {
    expect(formatBytes(1.25 * 1024 * 1024 * 1024)).toBe('1.3 GB')
    expect(formatBytes(12 * 1024 * 1024 * 1024)).toBe('12 GB')
  })

  it('handles zero and nonsense input', () => {
    expect(formatBytes(0)).toBe('0 MB')
    expect(formatBytes(-5)).toBe('0 MB')
    expect(formatBytes(Number.NaN)).toBe('0 MB')
  })
})

describe('formatStoragePercent', () => {
  it('rounds to whole percent', () => {
    expect(formatStoragePercent(0.876)).toBe('88%')
  })
})
