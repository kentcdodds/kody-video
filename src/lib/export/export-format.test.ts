import { describe, expect, it } from 'vitest'
import { resolveExportFormat } from '../types'
import { effectiveExportFormat } from './export-format'

describe('resolveExportFormat', () => {
  it('defaults anything but webm to mp4', () => {
    expect(resolveExportFormat('webm')).toBe('webm')
    expect(resolveExportFormat('mp4')).toBe('mp4')
    expect(resolveExportFormat(undefined)).toBe('mp4')
    expect(resolveExportFormat('mov')).toBe('mp4')
  })
})

describe('effectiveExportFormat', () => {
  it('keeps the preference while support is unknown or available', () => {
    expect(effectiveExportFormat('webm', null)).toBe('webm')
    expect(effectiveExportFormat('mp4', { mp4: true, webm: true })).toBe('mp4')
    expect(effectiveExportFormat('webm', { mp4: true, webm: true })).toBe('webm')
  })

  it('falls back to the format this browser can encode', () => {
    // iPhone: no WebM encoder.
    expect(effectiveExportFormat('webm', { mp4: true, webm: false })).toBe('mp4')
    // Chromium without H.264.
    expect(effectiveExportFormat('mp4', { mp4: false, webm: true })).toBe('webm')
  })

  it('keeps the preference when neither probe passed (realtime engine decides)', () => {
    expect(effectiveExportFormat('mp4', { mp4: false, webm: false })).toBe('mp4')
  })
})
