import { describe, expect, it } from 'vitest'
import { captureLiveThumbsFromStream, waitForVideoFrame } from './thumbs'

function paintCanvas(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2d context')
  ctx.fillStyle = '#1a7a4c'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

describe('waitForVideoFrame', () => {
  it('resolves true once a canvas stream has a frame', async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    paintCanvas(canvas)
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = canvas.captureStream(15)
    const ready = await waitForVideoFrame(video, 1000)
    expect(ready).toBe(true)
    expect(video.videoWidth).toBeGreaterThan(0)
    video.srcObject = null
  })
})

describe('captureLiveThumbsFromStream', () => {
  it('draws a poster from a live video track without using an on-screen element', async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 72
    paintCanvas(canvas)
    const timer = window.setInterval(() => paintCanvas(canvas), 30)
    const stream = canvas.captureStream(15)
    try {
      const thumbs = await captureLiveThumbsFromStream(stream, 1000)
      expect(thumbs).not.toBeNull()
      expect(thumbs!.thumbs.length).toBe(1)
      expect(thumbs!.poster.size).toBeGreaterThan(0)
      expect(thumbs!.videoWidth).toBeGreaterThan(0)
    } finally {
      window.clearInterval(timer)
      stream.getTracks().forEach((track) => {
        track.stop()
      })
    }
  })

  it('returns null when the stream has no live video', async () => {
    expect(await captureLiveThumbsFromStream(new MediaStream())).toBeNull()
    expect(await captureLiveThumbsFromStream(null)).toBeNull()
  })
})
