import { afterEach, describe, expect, it } from 'vitest'
import {
  activeBackgroundWork,
  beginCaptureActivity,
  isCaptureActive,
  resetCaptureActivityForTests,
  runWhenCaptureIdle,
  whenCaptureIdle,
} from './capture-activity'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('capture activity', () => {
  afterEach(() => {
    resetCaptureActivityForTests()
  })

  it('is idle until a take begins', async () => {
    expect(isCaptureActive()).toBe(false)
    await expect(whenCaptureIdle()).resolves.toBeUndefined()
  })

  it('holds optional work until the last overlapping take releases', async () => {
    const releaseFirst = beginCaptureActivity()
    const releaseSecond = beginCaptureActivity()
    const ran: string[] = []
    const work = runWhenCaptureIdle('hydrate-audio-peak', async () => {
      ran.push('hydrate')
      return 42
    })
    await tick()
    expect(ran).toEqual([])
    releaseFirst()
    await tick()
    expect(ran).toEqual([])
    releaseSecond()
    await expect(work).resolves.toBe(42)
    expect(ran).toEqual(['hydrate'])
  })

  it('treats a double release as one', async () => {
    const releaseA = beginCaptureActivity()
    const releaseB = beginCaptureActivity()
    releaseA()
    releaseA()
    expect(isCaptureActive()).toBe(true)
    releaseB()
    expect(isCaptureActive()).toBe(false)
  })

  it('reports which optional work is running', async () => {
    let finish: () => void = () => undefined
    const work = runWhenCaptureIdle(
      'take-analysis',
      () => new Promise<void>((resolve) => (finish = resolve)),
    )
    await tick()
    expect(activeBackgroundWork()).toEqual(['take-analysis'])
    finish()
    await work
    expect(activeBackgroundWork()).toEqual([])
  })
})
