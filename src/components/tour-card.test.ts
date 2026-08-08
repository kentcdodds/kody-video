import { afterEach, describe, expect, it, vi } from 'vitest'
import { openTourFromGesture } from './tour-card'

describe('openTourFromGesture', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('opens a closed dialog, plays on every call, and is safe while open', () => {
    const dialog = document.createElement('dialog')
    const video = document.createElement('video')
    dialog.append(video)
    document.body.append(dialog)
    const play = vi.spyOn(video, 'play').mockResolvedValue(undefined)

    openTourFromGesture(dialog, video)
    expect(dialog.open).toBe(true)
    expect(play).toHaveBeenCalledTimes(1)

    // A double-tap / second click used to throw InvalidStateError here.
    expect(() => openTourFromGesture(dialog, video)).not.toThrow()
    expect(dialog.open).toBe(true)
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('swallows rejected play() promises', async () => {
    const dialog = document.createElement('dialog')
    const video = document.createElement('video')
    dialog.append(video)
    document.body.append(dialog)
    const play = vi.spyOn(video, 'play').mockRejectedValue(new Error('autoplay blocked'))

    expect(() => openTourFromGesture(dialog, video)).not.toThrow()
    expect(dialog.open).toBe(true)
    expect(play).toHaveBeenCalledTimes(1)
    // Flush the rejected play() so an unhandled rejection would fail the test.
    await Promise.resolve()
  })

  it('no-ops when the dialog ref is missing', () => {
    expect(() => openTourFromGesture(null, null)).not.toThrow()
  })
})
