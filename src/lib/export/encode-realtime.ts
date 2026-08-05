import { pickRecorderMimeType } from '../media'
import { clipMusicVolume, clipSoundVolume, resolveAudioTrackPlayback } from '../types'
import {
  FADE_IN_MS,
  FADE_OUT_MS,
  channelPeak,
  filmEdgeFades,
  normalizationScale,
  type BackgroundAudio,
} from './background-audio'
import { clampSegmentToMedia, type ExportPlan } from './plan'
import {
  PREVIEW_EVERY_N_FRAMES,
  blitPreview,
  decodeBackgroundAudio,
  decodeClipAudio,
  drawCover,
  drawWatermark,
  loadClipVideo,
  pickOutputSize,
  recordVideoLumaSample,
  seekTo,
  tagExportError,
  wait,
  waitForPreviewCanvas,
  type ExportResult,
} from './shared'

export interface RealtimeExportOptions {
  /**
   * AudioContext created/resumed from the user's tap so Android allows audio
   * mixing. The export closes it when finished.
   */
  audioContext?: AudioContext
  onProgress?: (ratio: number) => void
  /** Visible canvas to mirror sampled frames onto while exporting. */
  getPreviewCanvas?: () => HTMLCanvasElement | null
  /** Mark stamped onto each frame; null when the user purchased removal. */
  watermarkImage?: HTMLImageElement | null
  /** Background-music playlist mixed under the clips (per-clip volumes). */
  background?: BackgroundAudio | null
}

/**
 * Fallback stitcher for browsers without WebCodecs: plays each clip into a
 * canvas captured by MediaRecorder, mixing audio via Web Audio. Realtime and
 * best-effort — the WebCodecs engine is preferred whenever available.
 */
export async function exportRealtime(
  plan: ExportPlan,
  options: RealtimeExportOptions = {},
): Promise<ExportResult> {
  const probeClip = plan.segments[0].clip
  let width: number
  let height: number
  try {
    const probe = await loadClipVideo(probeClip.blob, 8000, probeClip.mimeType)
    ;({ width, height } = pickOutputSize(probe.video.videoWidth, probe.video.videoHeight))
    probe.release()
  } catch (error) {
    // Probing is not worth dying over: recorded clips carry their capture
    // dimensions, and pickOutputSize has sane defaults for the rest.
    if ((probeClip.width ?? 0) > 0 && (probeClip.height ?? 0) > 0) {
      ;({ width, height } = pickOutputSize(probeClip.width!, probeClip.height!))
    } else {
      throw tagExportError(error, { engine: 'realtime', where: 'probe-size', clipIndex: 0 })
    }
  }

  // Encode from the overlay's on-DOM canvas whenever possible: iOS Safari's
  // canvas.captureStream() delivers BLACK frames for canvases that aren't
  // attached to the document (the preview looked fine — it was a different,
  // visible canvas — while the detached encode canvas produced a black
  // export). Rendering into the visible canvas fixes that and makes the
  // preview show every frame. The overlay mounts a tick after the export
  // starts, so wait briefly for it before falling back.
  let canvas = await waitForPreviewCanvas(options.getPreviewCanvas)
  const encodingIntoPreview = canvas !== null
  if (!canvas) {
    canvas = document.createElement('canvas')
  }
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Canvas not available')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)

  const canvasStream = canvas.captureStream(30)
  if (canvasStream.getVideoTracks().length === 0) {
    throw new Error('This browser cannot capture canvas video for export')
  }

  let audioContext: AudioContext | null = options.audioContext ?? null
  let dest: MediaStreamAudioDestinationNode | null = null
  try {
    if (!audioContext) audioContext = new AudioContext()
    if (audioContext.state === 'suspended') {
      await audioContext.resume().catch(() => undefined)
    }
    dest = audioContext.createMediaStreamDestination()
  } catch {
    audioContext = null
    dest = null
  }

  // Clip audio flows through one gain node that glides toward each clip's
  // own sound volume as the export reaches it — this engine paints in
  // realtime, so Web Audio's own ramping does the work. Every clip is
  // peak-normalized on the way in (per-segment gain), music or not.
  /** Gain the clips' own audio plays through (each clip's sound volume). */
  let clipMixGain: GainNode | null = null
  if (audioContext && dest) {
    try {
      const clipGain = audioContext.createGain()
      clipGain.gain.value = 1
      clipGain.connect(dest)
      clipMixGain = clipGain
    } catch {
      clipMixGain = null
    }
  }

  // Background music rides sequentially chained buffer sources behind a
  // gain node: each track starts when the previous one ends (nothing
  // loops), and the gain glides toward each clip's music volume as the
  // export reaches it. Tracks are peak-normalized and carry their own
  // volume via a per-source gain.
  let backgroundGain: GainNode | null = null
  /** Set once the playlist has truly run out — later segments must stop
   * scheduling music moves (the film's remainder is music-free). */
  const playlistState = { done: false }
  let startBackground: (() => void) | null = null
  let stopBackground: (() => void) | null = null
  const backgroundTracks = options.background?.tracks ?? []
  /** Film-edge fades come from the tracks at the film's edges. */
  const backgroundEdgeFades = options.background
    ? filmEdgeFades(options.background, plan.totalMs)
    : null
  if (backgroundTracks.length > 0 && audioContext && dest) {
    try {
      const gain = audioContext.createGain()
      gain.gain.value = 0
      gain.connect(dest)
      let stopped = false
      /** Output position where the next track starts (the kept windows
       * played so far) — the realtime mirror of the mixer's
       * trackStartFrame, used to gate interior fades the same way. */
      let playlistPositionMs = 0
      let activeSource: AudioBufferSourceNode | null = null
      const playFrom = async (index: number): Promise<void> => {
        if (stopped || !audioContext) return
        if (index >= backgroundTracks.length) {
          // Playlist over mid-film: the rest of the film is music-free
          // (the clip sound rides its own gain, unaffected).
          playlistState.done = true
          return
        }
        // Undecodable tracks are skipped; the next one starts in their place.
        const buffer = await decodeBackgroundAudio(backgroundTracks[index].blob)
        if (stopped) return
        if (!buffer) return playFrom(index + 1)
        // Only the kept (trimmed) window plays, at the track's own volume.
        const playback = resolveAudioTrackPlayback(backgroundTracks[index], options.background!)
        const trimStartSec = Math.min(playback.trimStartMs / 1000, buffer.duration)
        const trimEndSec = Math.min(playback.trimEndMs / 1000, buffer.duration)
        const keptSec = Math.max(0, trimEndSec - trimStartSec)
        if (keptSec < 0.05) return playFrom(index + 1)
        const source = audioContext.createBufferSource()
        source.buffer = buffer
        // Peak-normalize the track so the volume dials mean the same thing
        // regardless of how hot the file is mastered (whole-file peak, so
        // loudness doesn't change with where the track is trimmed), then
        // apply the track's own volume on top.
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) =>
          buffer.getChannelData(ch),
        )
        const trackGain = normalizationScale(channelPeak(channels)) * playback.volume
        const normalize = audioContext.createGain()
        normalize.gain.value = trackGain
        const now = audioContext.currentTime
        const trackStartMs = playlistPositionMs
        playlistPositionMs += keptSec * 1000
        // Interior fades only, matching the WebCodecs mixer: the
        // film-start fade rides the master gain glide below, so a track
        // fade-in applies only mid-film — and a track the film cuts off
        // fades via the scheduled film-end fade instead of its own.
        if (playback.fadeIn && trackStartMs > 0) {
          const fadeSec = Math.min(FADE_IN_MS / 1000, keptSec / 2)
          normalize.gain.setValueAtTime(0, now)
          normalize.gain.linearRampToValueAtTime(trackGain, now + fadeSec)
        }
        if (playback.fadeOut && playlistPositionMs < plan.totalMs) {
          const fadeSec = Math.min(FADE_OUT_MS / 1000, keptSec / 2)
          normalize.gain.setValueAtTime(trackGain, now + keptSec - fadeSec)
          normalize.gain.linearRampToValueAtTime(0, now + keptSec)
        }
        source.connect(normalize)
        normalize.connect(gain)
        source.onended = () => {
          void playFrom(index + 1)
        }
        activeSource = source
        source.start(now, trimStartSec, keptSec)
      }
      // Deferred to the first painted segment: starting here would let the
      // music advance through clip preload before any frame is recorded.
      startBackground = () => {
        startBackground = null
        void playFrom(0)
      }
      stopBackground = () => {
        stopped = true
        try {
          activeSource?.stop()
        } catch {
          // already stopped
        }
      }
      backgroundGain = gain
    } catch {
      backgroundGain = null
      startBackground = null
      stopBackground = null
    }
  }

  const mixedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...(dest?.stream.getAudioTracks() ?? []),
  ])

  const mimeType = pickRecorderMimeType()
  let recorder: MediaRecorder
  try {
    recorder = mimeType
      ? new MediaRecorder(mixedStream, { mimeType, videoBitsPerSecond: 3_000_000 })
      : new MediaRecorder(mixedStream)
  } catch {
    recorder = new MediaRecorder(mixedStream)
  }

  const chunks: BlobPart[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }))
    recorder.onerror = () => reject(new Error('Export recording failed'))
  })

  recorder.start(200)
  await wait(120)

  let paintedTotalMs = 0
  const frameCounter = { count: 0 }
  try {
    for (const [segmentIndex, segment] of plan.segments.entries()) {
      let loaded: Awaited<ReturnType<typeof loadClipVideo>>
      try {
        loaded = await loadClipVideo(segment.clip.blob, 8000, segment.clip.mimeType)
      } catch (error) {
        // The realtime engine plays clips through elements — this clip is
        // genuinely unopenable here. Tag which one for the error report.
        throw tagExportError(error, {
          engine: 'realtime',
          where: 'segment-load',
          clipIndex: segmentIndex,
        })
      }
      try {
        const clamped = clampSegmentToMedia(segment, loaded.mediaDurationMs)
        if (!clamped) continue
        if (audioContext) {
          const now = audioContext.currentTime
          // The clip's own sound glides toward this clip's volume (a step
          // at the very first segment — nothing is sounding before it).
          // Each bus is guarded on its own — a failed clip gain node must
          // not leave the music bus unscheduled (parked at 0) too.
          if (clipMixGain) {
            const clipLevel = clipSoundVolume(segment.clip)
            if (segmentIndex === 0) {
              clipMixGain.gain.setValueAtTime(clipLevel, now)
            } else {
              clipMixGain.gain.setTargetAtTime(clipLevel, now, 0.2)
            }
          }
          if (backgroundGain && options.background) {
            startBackground?.()
            // A finished playlist means the rest of the film is music-free —
            // re-scheduling a music level would move a silent bus for nothing.
            const musicLevel = playlistState.done ? 0 : clipMusicVolume(segment.clip)
            if (segmentIndex === 0 && !backgroundEdgeFades?.fadeIn) {
              // No fade-in: the music opens at the clip's level directly.
              backgroundGain.gain.setValueAtTime(musicLevel, now)
            } else {
              backgroundGain.gain.setTargetAtTime(musicLevel, now, 0.2)
            }
            // This engine paints in realtime, so the last segment's end
            // lands roughly `segment length` from now — schedule the
            // musical fade-out to finish there, shrinking it on short
            // final clips (like the WebCodecs envelope) instead of
            // dropping it.
            const isLast = segmentIndex === plan.segments.length - 1
            const segmentSec = (clamped.endMs - clamped.startMs) / 1000
            if (isLast && backgroundEdgeFades?.fadeOut) {
              const fadeSec = Math.min(1.2, segmentSec / 2)
              if (fadeSec > 0.05) {
                backgroundGain.gain.setTargetAtTime(0, now + segmentSec - fadeSec, fadeSec / 3)
              }
            }
          }
        }
        const paintedMs = await paintSegment({
          video: loaded.video,
          blob: segment.clip.blob,
          startSec: clamped.startMs / 1000,
          endSec: clamped.endMs / 1000,
          canvas,
          ctx,
          audioContext,
          // Clip audio joins the graph through the clip-volume gain and
          // gets peak-normalized on the way in (music or not).
          clipDestination: clipMixGain ?? dest,
          normalizeClip: clipMixGain !== null,
          frameCounter,
          // No mirroring needed when the encode canvas is the preview.
          getPreviewCanvas: encodingIntoPreview ? undefined : options.getPreviewCanvas,
          watermarkImage: options.watermarkImage ?? null,
          onElapsedMs: (elapsed) => {
            if (plan.totalMs > 0) {
              options.onProgress?.(Math.min(1, (paintedTotalMs + elapsed) / plan.totalMs))
            }
          },
        })
        paintedTotalMs += paintedMs
        options.onProgress?.(plan.totalMs > 0 ? Math.min(1, paintedTotalMs / plan.totalMs) : 1)
      } finally {
        loaded.release()
      }
    }

    if (paintedTotalMs <= 0) {
      throw new Error('No video frames could be exported')
    }

    // End-of-film safety ramp: with Fade out on it just finishes what the
    // scheduled fade started; with it off, a click-kill too short to hear
    // as a fade (mirrors the WebCodecs edge ramp). The clip side keeps its
    // own level — the sides are independent now.
    if (backgroundGain && audioContext) {
      const tau = backgroundEdgeFades?.fadeOut ? 0.06 : 0.008
      backgroundGain.gain.setTargetAtTime(0, audioContext.currentTime, tau)
    }
    // Hold the last frame briefly so the final GOP isn't truncated.
    await wait(180)
    options.onProgress?.(1)
  } finally {
    stopBackground?.()
    if (recorder.state !== 'inactive') recorder.stop()
    canvasStream.getTracks().forEach((t) => t.stop())
    if (audioContext) {
      await audioContext.close().catch(() => undefined)
    }
  }

  const blob = await stopped
  if (blob.size < 8_000) {
    throw new Error('Export produced an unusable file')
  }
  const isMp4 = (recorder.mimeType || '').includes('mp4')
  return {
    blob,
    mimeType: blob.type || 'video/webm',
    fileExtension: isMp4 ? 'mp4' : 'webm',
  }
}

interface PaintSegmentArgs {
  video: HTMLVideoElement
  blob: Blob
  startSec: number
  endSec: number
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  audioContext: AudioContext | null
  /** Where the clip's own audio joins the recording graph (the clip-volume
   * gain when the graph exists, else the mux destination). */
  clipDestination: AudioNode | null
  /** Peak-normalize the clip audio (on whenever the graph exists). */
  normalizeClip: boolean
  frameCounter: { count: number }
  getPreviewCanvas?: () => HTMLCanvasElement | null
  watermarkImage: HTMLImageElement | null
  onElapsedMs: (elapsedMs: number) => void
}

/** @returns painted duration in ms (0 when the segment had nothing to show) */
async function paintSegment({
  video,
  blob,
  startSec,
  endSec,
  canvas,
  ctx,
  audioContext,
  clipDestination,
  normalizeClip,
  frameCounter,
  getPreviewCanvas,
  watermarkImage,
  onElapsedMs,
}: PaintSegmentArgs): Promise<number> {
  const segmentSec = endSec - startSec
  if (segmentSec <= 0.04) return 0

  await seekTo(video, startSec)

  let bufferSource: AudioBufferSourceNode | null = null
  let normalizeGain: GainNode | null = null
  const audioBuffer = audioContext && clipDestination ? await decodeClipAudio(blob) : null

  try {
    video.muted = true
    await video.play()
    await waitForPlaybackStart(video, startSec)

    const paintFrame = () => {
      drawCover(ctx, video, canvas.width, canvas.height)
      if (watermarkImage) {
        drawWatermark(ctx, watermarkImage, canvas.width, canvas.height)
      }
    }
    paintFrame()

    if (audioContext && clipDestination && audioBuffer) {
      const videoLeadSec = Math.max(0, video.currentTime - startSec)
      const offset = Math.min(startSec + videoLeadSec, Math.max(0, audioBuffer.duration - 0.01))
      const available = Math.max(0, audioBuffer.duration - offset)
      const playDuration = Math.max(0, Math.min(segmentSec - videoLeadSec, available))
      if (playDuration > 0.05) {
        try {
          bufferSource = audioContext.createBufferSource()
          bufferSource.buffer = audioBuffer
          let clipOutput: AudioNode = bufferSource
          if (normalizeClip) {
            // Peak-normalize so the volume dials mean the same thing however
            // hot (or quiet) the mic recording is.
            const channels = Array.from(
              { length: audioBuffer.numberOfChannels },
              (_, ch) => audioBuffer.getChannelData(ch),
            )
            normalizeGain = audioContext.createGain()
            normalizeGain.gain.value = normalizationScale(channelPeak(channels))
            bufferSource.connect(normalizeGain)
            clipOutput = normalizeGain
          }
          clipOutput.connect(clipDestination)
          bufferSource.start(audioContext.currentTime, offset, playDuration)
        } catch {
          bufferSource = null
          normalizeGain = null
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      let raf = 0
      let lastFrameAt = performance.now()
      let lastVideoTime = video.currentTime

      const finish = () => {
        paintFrame()
        cancelAnimationFrame(raf)
        video.pause()
        resolve()
      }

      const draw = () => {
        const now = performance.now()
        const elapsed = Math.max(0, video.currentTime - startSec)
        if (video.ended || video.currentTime >= endSec - 0.04 || elapsed >= segmentSec - 0.03) {
          finish()
          return
        }
        if (video.currentTime > lastVideoTime + 0.001) {
          lastVideoTime = video.currentTime
          lastFrameAt = now
        } else if (now - lastFrameAt > 8000) {
          cancelAnimationFrame(raf)
          video.pause()
          reject(new Error('Clip playback stalled during export'))
          return
        }
        paintFrame()
        if (frameCounter.count % PREVIEW_EVERY_N_FRAMES === 0) {
          blitPreview(canvas, getPreviewCanvas?.())
        }
        if (frameCounter.count % 30 === 0) {
          recordVideoLumaSample(canvas)
        }
        frameCounter.count += 1
        onElapsedMs(Math.min(segmentSec, elapsed) * 1000)
        raf = requestAnimationFrame(draw)
      }

      video.onerror = () => {
        cancelAnimationFrame(raf)
        reject(new Error('A clip failed to play during export'))
      }
      raf = requestAnimationFrame(draw)
    })

    return Math.round(segmentSec * 1000)
  } finally {
    video.onerror = null
    try {
      bufferSource?.stop()
    } catch {
      // already ended
    }
    bufferSource?.disconnect()
    normalizeGain?.disconnect()
  }
}

async function waitForPlaybackStart(video: HTMLVideoElement, startSec: number): Promise<void> {
  if (video.currentTime > startSec + 0.01) return
  const deadline = performance.now() + 1500
  await new Promise<void>((resolve) => {
    const tick = () => {
      if (video.currentTime > startSec + 0.01 || video.ended || performance.now() > deadline) {
        resolve()
        return
      }
      requestAnimationFrame(tick)
    }
    tick()
  })
}
