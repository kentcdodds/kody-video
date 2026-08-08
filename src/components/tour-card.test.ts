import { afterEach, describe, expect, it } from 'vitest'
import { openTourFromGesture } from './tour-card'

describe('openTourFromGesture', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('opens a closed dialog and is safe to call again while open', () => {
    const dialog = document.createElement('dialog')
    const video = document.createElement('video')
    dialog.append(video)
    document.body.append(dialog)

    openTourFromGesture(dialog, video)
    expect(dialog.open).toBe(true)

    // A double-tap / second click used to throw InvalidStateError here.
    expect(() => openTourFromGesture(dialog, video)).not.toThrow()
    expect(dialog.open).toBe(true)
  })

  it('no-ops when the dialog ref is missing', () => {
    expect(() => openTourFromGesture(null, null)).not.toThrow()
  })
})
