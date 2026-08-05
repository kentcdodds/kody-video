import { describe, expect, it } from 'vitest'
import { COMMIT_SHA, commitUrl, shortVersion } from './build-info'

describe('build-info', () => {
  it('exposes a short version label', () => {
    expect(shortVersion()).toBe(COMMIT_SHA === 'dev' ? 'dev' : COMMIT_SHA.slice(0, 7))
  })

  it('links real commits to GitHub and leaves local builds unlinked', () => {
    if (COMMIT_SHA === 'dev') {
      expect(commitUrl()).toBeNull()
      return
    }
    expect(commitUrl()).toBe(`https://github.com/kentcdodds/kody-video/commit/${COMMIT_SHA}`)
  })
})
