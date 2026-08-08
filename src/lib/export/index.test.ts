import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClipRecord } from '../types'

vi.mock('./encode-realtime', () => ({
  exportRealtime: vi.fn(async () => ({
    blob: new Blob([new Uint8Array(2048)], { type: 'video/webm' }),
    mimeType: 'video/webm',
    fileExtension: 'webm' as const,
    locationIncluded: false,
    engine: 'realtime' as const,
  })),
}))

vi.mock('./encode-webcodecs', () => ({
  supportsWebCodecsExport: vi.fn(() => false),
  exportWithWebCodecs: vi.fn(),
}))

import { exportRealtime } from './encode-realtime'
import { exportWithWebCodecs, supportsWebCodecsExport } from './encode-webcodecs'
import { exportProject } from './index'

function clip(): ClipRecord {
  return {
    id: 'clip_fallback_test',
    projectId: 'proj_fallback_test',
    blob: new Blob([new Uint8Array(64)], { type: 'video/webm' }),
    mimeType: 'video/webm',
    durationMs: 400,
    trimStartMs: 0,
    trimEndMs: 400,
    createdAt: Date.now(),
    width: 320,
    height: 568,
  }
}

describe('exportProject fallback signaling', () => {
  beforeEach(() => {
    vi.mocked(supportsWebCodecsExport).mockReturnValue(false)
    vi.mocked(exportWithWebCodecs).mockReset()
    vi.mocked(exportRealtime).mockClear()
  })

  it('calls onFallback once when WebCodecs is unavailable', async () => {
    const onFallback = vi.fn()
    const result = await exportProject([clip()], {
      watermark: false,
      onFallback,
    })
    expect(onFallback).toHaveBeenCalledTimes(1)
    expect(exportWithWebCodecs).not.toHaveBeenCalled()
    expect(exportRealtime).toHaveBeenCalledTimes(1)
    expect(result.engine).toBe('realtime')
    expect(result.locationIncluded).toBe(false)
  })

  it('calls onFallback after WebCodecs fails', async () => {
    vi.mocked(supportsWebCodecsExport).mockReturnValue(true)
    vi.mocked(exportWithWebCodecs).mockRejectedValue(new Error('encode boom'))
    const onFallback = vi.fn()
    const result = await exportProject([clip()], {
      watermark: false,
      onFallback,
    })
    expect(exportWithWebCodecs).toHaveBeenCalledTimes(1)
    expect(onFallback).toHaveBeenCalledTimes(1)
    expect(exportRealtime).toHaveBeenCalledTimes(1)
    expect(result.engine).toBe('realtime')
  })

  it('does not call onFallback when WebCodecs succeeds', async () => {
    vi.mocked(supportsWebCodecsExport).mockReturnValue(true)
    vi.mocked(exportWithWebCodecs).mockResolvedValue({
      blob: new Blob([new Uint8Array(2048)], { type: 'video/mp4' }),
      mimeType: 'video/mp4',
      fileExtension: 'mp4',
      locationIncluded: true,
      engine: 'webcodecs',
    })
    // Silence verification needs no audible input peak — leave diagnostics empty.
    const onFallback = vi.fn()
    const result = await exportProject([clip()], {
      watermark: false,
      onFallback,
    })
    expect(onFallback).not.toHaveBeenCalled()
    expect(exportRealtime).not.toHaveBeenCalled()
    expect(result.engine).toBe('webcodecs')
    expect(result.locationIncluded).toBe(true)
  })
})
