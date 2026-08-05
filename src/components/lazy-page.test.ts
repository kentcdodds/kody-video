import { describe, expect, it } from 'vitest'
import { isChunkLoadError } from './lazy-page'

describe('isChunkLoadError', () => {
  it('matches Chromium / Vite dynamic import failures', () => {
    expect(
      isChunkLoadError(
        new Error(
          'Failed to fetch dynamically imported module: https://kody.video/assets/project-page-abc.js',
        ),
      ),
    ).toBe(true)
    expect(
      isChunkLoadError(new Error('error loading dynamically imported module')),
    ).toBe(true)
    expect(isChunkLoadError(new Error('Loading chunk 5 failed'))).toBe(true)
  })

  it('ignores ordinary application errors', () => {
    expect(isChunkLoadError(new Error('Project not found'))).toBe(false)
    expect(isChunkLoadError('random string')).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
  })
})
