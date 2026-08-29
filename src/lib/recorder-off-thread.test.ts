import { afterEach, describe, expect, it } from 'vitest'
import {
  canRecordOffThread,
  reattachReturnedAudio,
  resetRecorderOffThreadForTests,
  setRecorderOffThreadEnabledForTests,
  swapAudioForPlaceholders,
} from './recorder-off-thread'
import { HoldRecorder } from './recorder'

afterEach(() => {
  resetRecorderOffThreadForTests()
})

function makeAudioTrack(): MediaStreamTrack {
  const context = new AudioContext()
  const oscillator = context.createOscillator()
  const destination = context.createMediaStreamDestination()
  oscillator.connect(destination)
  oscillator.start()
  const track = destination.stream.getAudioTracks()[0]
  if (!track) throw new Error('No audio track')
  // Keep the context alive on the track so the test can stop it.
  ;(track as MediaStreamTrack & { __ctx?: AudioContext }).__ctx = context
  return track
}

function makeVideoTrack(): MediaStreamTrack {
  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 16
  const track = canvas.captureStream(0).getVideoTracks()[0]
  if (!track) throw new Error('No video track')
  return track
}

describe('canRecordOffThread', () => {
  it('is true in Chromium (track transfer + Worker + MediaRecorder)', () => {
    expect(canRecordOffThread()).toBe(true)
  })

  it('honors the test override', () => {
    setRecorderOffThreadEnabledForTests(false)
    expect(canRecordOffThread()).toBe(false)
    setRecorderOffThreadEnabledForTests(true)
    expect(canRecordOffThread()).toBe(true)
  })
})

describe('swapAudioForPlaceholders / reattachReturnedAudio', () => {
  it('leaves clones on the stream and can put live originals back', () => {
    const audio = makeAudioTrack()
    const video = makeVideoTrack()
    const stream = new MediaStream([video, audio])
    const { originals, placeholders } = swapAudioForPlaceholders(stream)
    expect(originals).toEqual([audio])
    expect(placeholders).toHaveLength(1)
    expect(stream.getAudioTracks()).toEqual(placeholders)
    expect(placeholders[0]?.readyState).toBe('live')

    reattachReturnedAudio(stream, placeholders, originals)
    expect(stream.getAudioTracks()).toEqual([audio])
    expect(audio.readyState).toBe('live')

    audio.stop()
    video.stop()
    placeholders[0]?.stop()
    void (audio as MediaStreamTrack & { __ctx?: AudioContext }).__ctx?.close()
  })

  it('keeps placeholders when nothing live comes back', () => {
    const audio = makeAudioTrack()
    const stream = new MediaStream([audio])
    const { placeholders } = swapAudioForPlaceholders(stream)
    reattachReturnedAudio(stream, placeholders, [])
    expect(stream.getAudioTracks()).toEqual(placeholders)
    audio.stop()
    placeholders[0]?.stop()
    void (audio as MediaStreamTrack & { __ctx?: AudioContext }).__ctx?.close()
  })
})

async function recordTake(enabled: boolean): Promise<{
  thread: 'worker' | 'main' | 'idle'
  size: number
  durationMs: number
}> {
  setRecorderOffThreadEnabledForTests(enabled)
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 180
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2d context')
  let frame = 0
  const draw = () => {
    ctx.fillStyle = `hsl(${frame % 360}, 70%, 40%)`
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    frame += 1
  }
  draw()
  const timer = window.setInterval(draw, 33)
  const stream = canvas.captureStream(30)
  const audio = makeAudioTrack()
  stream.addTrack(audio)
  const recorder = new HoldRecorder()
  try {
    recorder.arm(stream)
    const started = await recorder.start(stream)
    expect(started).toBe(true)
    const thread = recorder.captureThread
    await new Promise((resolve) => {
      window.setTimeout(resolve, 700)
    })
    const result = await recorder.stop({ graceMs: 0 })
    expect(result).not.toBeNull()
    expect(result!.blob.size).toBeGreaterThan(0)
    return { thread, size: result!.blob.size, durationMs: result!.durationMs }
  } finally {
    recorder.cancel()
    window.clearInterval(timer)
    stream.getTracks().forEach((track) => {
      track.stop()
    })
    void (audio as MediaStreamTrack & { __ctx?: AudioContext }).__ctx?.close()
  }
}

describe('HoldRecorder capture backends', () => {
  it('records a clip on the worker path', async () => {
    const take = await recordTake(true)
    expect(take.thread).toBe('worker')
    expect(take.durationMs).toBeGreaterThan(400)
  })

  it('falls back to the main-thread path when the worker is disabled', async () => {
    const take = await recordTake(false)
    expect(take.thread).toBe('main')
    expect(take.durationMs).toBeGreaterThan(400)
  })
})
