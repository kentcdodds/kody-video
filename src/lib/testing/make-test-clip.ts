import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Output,
  Quality,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from 'mediabunny'

/**
 * Deterministic fixture clips for the e2e suite (imported in-page through
 * the vite dev server; never referenced by app code, so it ships nowhere).
 *
 * Real MediaRecorder capture is covered by the recording specs, but tests
 * that merely need clips as fixtures can't afford it: under CI load the
 * recorder starves for frames and a multi-second hold can measure under the
 * 120ms minimum take. This encodes faster than realtime via WebCodecs with
 * an exact duration instead.
 *
 * Pass `toneHz` for a clip WITH an audio track: a steady sine tone, which
 * audio-continuity assertions (e.g. the clip-joint crossfade) can measure.
 */
export async function makeTestClipBlob(durationMs: number, toneHz?: number): Promise<Blob> {
  const width = 320
  const height = 568
  const fps = 15
  const codec = await getFirstEncodableVideoCodec(['vp8', 'vp9'], { width, height })
  if (!codec) throw new Error('No encodable test codec')

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not available')

  const target = new BufferTarget()
  const output = new Output({ format: new WebMOutputFormat(), target })
  const source = new CanvasSource(canvas, {
    codec,
    quality: new Quality({ bitrate: 400_000 }),
  })
  output.addVideoTrack(source, { frameRate: fps })

  let audioSource: AudioBufferSource | null = null
  if (toneHz) {
    const audioCodec = await getFirstEncodableAudioCodec(['opus'], {
      numberOfChannels: 1,
      sampleRate: 48000,
    })
    if (!audioCodec) throw new Error('No encodable test audio codec')
    audioSource = new AudioBufferSource({
      codec: audioCodec,
      quality: new Quality({ bitrate: 96_000 }),
    })
    output.addAudioTrack(audioSource)
  }

  await output.start()

  if (audioSource && toneHz) {
    const rate = 48000
    const frames = Math.max(1, Math.round((durationMs / 1000) * rate))
    const buffer = new AudioBuffer({ length: frames, sampleRate: rate, numberOfChannels: 1 })
    const data = buffer.getChannelData(0)
    for (let i = 0; i < frames; i += 1) {
      data[i] = 0.5 * Math.sin((2 * Math.PI * toneHz * i) / rate)
    }
    await audioSource.add(buffer)
    audioSource.close()
  }

  const totalSec = durationMs / 1000
  const frames = Math.max(2, Math.ceil(totalSec * fps))
  for (let i = 0; i < frames; i += 1) {
    ctx.fillStyle = `hsl(${(i * 23) % 360}, 70%, 45%)`
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#fff'
    ctx.font = '48px sans-serif'
    ctx.fillText(String(i), 24, 64)
    // Trim the last frame so the media duration matches durationMs exactly
    // (the stored ClipMeta.durationMs must agree with the encoded media).
    // The 1ms floor keeps the minimum two frames valid for durations under
    // one frame interval.
    const duration = Math.max(0.001, Math.min(1 / fps, totalSec - i / fps))
    await source.add(i / fps, duration)
  }
  source.close()
  await output.finalize()

  if (!target.buffer) throw new Error('Test clip encode produced no bytes')
  return new Blob([target.buffer], { type: 'video/webm' })
}
