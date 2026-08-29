import { afterEach, describe, expect, it } from 'vitest'
import { measureRecordedVideo, type CaptureStats } from './recorder-capture-stats'
import { resetRecorderOffThreadForTests, setRecorderOffThreadEnabledForTests } from './recorder-off-thread'
import { HoldRecorder } from './recorder'

/**
 * A/B: same 30fps canvas + mic, same main-thread jank, worker vs in-page
 * MediaRecorder. The merge gate is the printed verdict — this file always
 * asserts both paths produce a real clip so CI still has a functional check.
 */

afterEach(() => {
  resetRecorderOffThreadForTests()
})

function makeBusyJank(durationMs: number, blockMs: number, periodMs: number): () => void {
  const endAt = performance.now() + durationMs
  let timer = 0
  const tick = () => {
    if (performance.now() >= endAt) return
    const until = performance.now() + blockMs
    while (performance.now() < until) {
      // Occupied main thread — what a busy Remix update looks like.
    }
    timer = window.setTimeout(tick, Math.max(0, periodMs - blockMs))
  }
  tick()
  return () => window.clearTimeout(timer)
}

async function recordUnderLoad(offThread: boolean): Promise<{
  thread: 'worker' | 'main' | 'idle'
  stats: CaptureStats
  blobSize: number
}> {
  setRecorderOffThreadEnabledForTests(offThread)
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 360
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('No 2d context')
  let frame = 0
  const draw = () => {
    ctx.fillStyle = `hsl(${(frame * 17) % 360}, 80%, 45%)`
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#fff'
    ctx.font = '64px sans-serif'
    ctx.fillText(String(frame), 40, 80)
    frame += 1
  }
  draw()
  const drawTimer = window.setInterval(draw, 1000 / 30)
  const stream = canvas.captureStream(30)
  const audioContext = new AudioContext()
  const oscillator = audioContext.createOscillator()
  const destination = audioContext.createMediaStreamDestination()
  oscillator.frequency.value = 330
  oscillator.connect(destination)
  oscillator.start()
  destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track))

  const recorder = new HoldRecorder()
  const stopJank = makeBusyJank(2200, 18, 33)
  try {
    const started = await recorder.start(stream)
    if (!started) throw new Error('HoldRecorder.start failed')
    const thread = recorder.captureThread
    await new Promise((resolve) => {
      window.setTimeout(resolve, 2000)
    })
    const result = await recorder.stop({ graceMs: 0 })
    if (!result) throw new Error('empty take')
    const stats = await measureRecordedVideo(result.blob, 30)
    return { thread, stats, blobSize: result.blob.size }
  } finally {
    stopJank()
    recorder.cancel()
    window.clearInterval(drawTimer)
    oscillator.stop()
    void audioContext.close()
    stream.getTracks().forEach((track) => {
      track.stop()
    })
  }
}

describe('recorder thread bench', () => {
  it('compares worker vs main-thread capture under main-thread load', async () => {
    const main = await recordUnderLoad(false)
    const worker = await recordUnderLoad(true)
    expect(main.thread).toBe('main')
    expect(worker.thread).toBe('worker')
    expect(main.stats.frameCount).toBeGreaterThan(10)
    expect(worker.stats.frameCount).toBeGreaterThan(10)

    const fpsGain = worker.stats.achievedFps - main.stats.achievedFps
    const gapDrop = main.stats.largeGapCount - worker.stats.largeGapCount
    const frameGain = worker.stats.frameCount - main.stats.frameCount
    // Clear win: more frames / higher fps / fewer large timestamp gaps.
    // Tiny deltas are noise on a 2s canvas capture.
    const improved = frameGain >= 8 || fpsGain >= 2 || gapDrop >= 3
    const verdict = {
      improved,
      fpsGain,
      gapDrop,
      frameGain,
      main: { ...main.stats, blobSize: main.blobSize, thread: main.thread },
      worker: { ...worker.stats, blobSize: worker.blobSize, thread: worker.thread },
    }
    // eslint-disable-next-line no-console -- bench output is the merge evidence
    console.log(`RECORDER_THREAD_BENCH ${JSON.stringify(verdict)}`)
    expect(verdict.main.frameCount).toBeGreaterThan(10)
    expect(verdict.worker.frameCount).toBeGreaterThan(10)
  })
})
