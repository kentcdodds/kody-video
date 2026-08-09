import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny'
import { isIosBrowser } from '../platform'
import {
  clipMusicVolume,
  clipSoundVolume,
  isImageClip,
  resolveAudioTrackPlayback,
  type ClipRecord,
  type ProjectOrientation,
} from '../types'
import {
  applyGainEnvelope,
  boundaryRampHalfMs,
  channelPeak,
  createBackgroundMixer,
  filmEdgeFades,
  normalizationScale,
  planSegmentGain,
  type BackgroundAudio,
} from './background-audio'
import { injectMp4Metadata, type Mp4Chapter } from './mp4-metadata'
import { createOpfsExportFile } from './opfs'
import { clampSegmentToMedia, type ExportPlan } from './plan'
import { CROSSFADE_HALF_MS, flushCarry, sliceSegmentAudio } from './segment-audio'
import {
  PREVIEW_INTERVAL_MS,
  blitPreview,
  decodeBackgroundAudio,
  decodeClipAudio,
  drawCoverFrom,
  drawWatermark,
  loadClipImage,
  loadClipVideo,
  tagExportError,
  pickOutputSize,
  noteEncodeCanvasKind,
  recordVideoLumaSample,
  resolveEncodeCanvas,
  seekTo,
  type ExportResult,
} from './shared'
import {
  clipsSpanMultipleDays,
  formatChapterTitle,
  locationForExport,
} from './mp4-export-metadata'

const FPS = 30
const AUDIO_SAMPLE_RATE = 48000
const AUDIO_CHANNELS = 2
const AUDIO_BITRATE = 192_000
const KEYFRAME_INTERVAL_SEC = 2
// Decimation to the output frame rate runs against a virtual 30fps output
// clock (see makeFrameSink): high-rate sources otherwise push extra frames
// through the same bitrate budget, cutting bits-per-frame — that was the
// source of the blocky artifacts on long exports. The tolerance admits a
// frame slightly ahead of its tick so a jittery 30fps source never drops
// legitimate frames.
const FRAME_INTERVAL_SEC = 1 / FPS
const DECIMATE_TOLERANCE_SEC = 0.3 / FPS

/** ~0.12 bits per pixel at 30fps — clean hardware-AVC territory without
 * ballooning the file. Scales down for small outputs instead of spending a
 * flat 4Mbps on everything. */
function videoBitrateFor(width: number, height: number): number {
  return Math.round(Math.min(6_000_000, Math.max(1_500_000, width * height * FPS * 0.12)))
}

export function supportsWebCodecsExport(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'
}

interface CodecChoice {
  container: 'mp4' | 'webm'
  videoCodec: VideoCodec
  audioCodec: AudioCodec
}

/**
 * MP4 (H.264/HEVC + AAC) is strongly preferred: it's what every share
 * target, phone gallery, and player accepts. WebM (VP9/VP8 + Opus) is the
 * last resort for browsers without MP4 encoders (e.g. Chromium builds
 * without proprietary codecs) — and NEVER on iOS, where nothing plays or
 * shares WebM and VP encoding is software-slow. Mediabunny probes actual
 * encodability, including at the output dimensions.
 */
async function pickCodecs(width: number, height: number): Promise<CodecChoice | null> {
  const mp4Video = await getFirstEncodableVideoCodec(['avc', 'hevc'], { width, height })
  const mp4Audio = await getFirstEncodableAudioCodec(['aac'], {
    numberOfChannels: AUDIO_CHANNELS,
    sampleRate: AUDIO_SAMPLE_RATE,
  })
  if (mp4Video && mp4Audio) {
    return { container: 'mp4', videoCodec: mp4Video, audioCodec: mp4Audio }
  }
  if (isIosBrowser()) return null
  const webmVideo = await getFirstEncodableVideoCodec(['vp9', 'vp8'], { width, height })
  const webmAudio = await getFirstEncodableAudioCodec(['opus'], {
    numberOfChannels: AUDIO_CHANNELS,
    sampleRate: AUDIO_SAMPLE_RATE,
  })
  if (webmVideo && webmAudio) {
    return { container: 'webm', videoCodec: webmVideo, audioCodec: webmAudio }
  }
  return null
}

/**
 * Frame-accurate export built on Mediabunny: each clip's samples are
 * demuxed and decoded directly (no playback, no compositor dependency — the
 * frame supply runs at hardware speed and keeps flowing in background
 * tabs), composited onto one canvas with the watermark, and encoded/muxed
 * by Mediabunny, which owns the codec-config, packet-ordering, and
 * container details we used to hand-roll (and debug, chunk by chunk, on
 * iOS). Audio is decoded per clip and appended sample-accurately, so clips
 * can never drift against their soundtrack; adjacent clips crossfade at
 * each joint instead of dipping to silence (see segment-audio.ts).
 */
export async function exportWithWebCodecs(
  plan: ExportPlan,
  onProgress?: (ratio: number) => void,
  getPreviewCanvas?: () => HTMLCanvasElement | null,
  watermarkImage?: HTMLImageElement | null,
  background?: BackgroundAudio | null,
  orientation?: ProjectOrientation,
  includeLocation = false,
): Promise<ExportResult> {
  if (!supportsWebCodecsExport()) {
    throw new Error('WebCodecs is not available')
  }

  const { width, height } = await probeOutputSize(plan, orientation)
  const choice = await pickCodecs(width, height)
  if (!choice) {
    throw new Error('No supported export codec')
  }

  // iOS ONLY: encode into an on-DOM canvas — WebKit treats detached canvases
  // as black in capture/encode paths (black-export saga / KODY-VIDEO-Q).
  // Prefer the overlay preview; if it isn't mounted in time, attach a tiny
  // host rather than falling back to a detached element. Everywhere else the
  // encode canvas stays DETACHED: drawing every frame through a visible,
  // compositor-synchronized canvas rate-limited a 9× export to ~6× on
  // Android. The preview gets throttled downscaled blits instead.
  const ios = isIosBrowser()
  const encodeCanvas = await resolveEncodeCanvas({
    getPreviewCanvas,
    preferPreview: ios,
    requireAttached: ios,
  })
  noteEncodeCanvasKind(encodeCanvas.kind)
  const { canvas, encodingIntoPreview } = encodeCanvas
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) {
    encodeCanvas.release()
    throw new Error('Canvas not available')
  }

  try {
    // Stream the mux to disk when OPFS is available: long exports are too
    // big for an in-memory buffer (a half-hour project is ~1GB — the
    // BufferTarget path OOM-killed the tab right at 100%).
    const opfs = await createOpfsExportFile(choice.container)
    const output = new Output({
      format:
        choice.container === 'mp4'
          ? // Trailing moov so chapter/geotag injection can append udta
            // without rewriting stco/co64. Exports are saved/shared, not
            // streamed, so faststart matters little here.
            new Mp4OutputFormat({ fastStart: false })
          : new WebMOutputFormat(),
      target: opfs ? new StreamTarget(opfs.writable, { chunked: true }) : new BufferTarget(),
    })
    const videoSource = new CanvasSource(canvas, {
      codec: choice.videoCodec,
      quality: new Quality({ bitrate: videoBitrateFor(width, height) }),
      keyFrameInterval: KEYFRAME_INTERVAL_SEC,
    })
    output.addVideoTrack(videoSource, { frameRate: FPS })
    const audioSource = new AudioBufferSource({
      codec: choice.audioCodec,
      quality: new Quality({ bitrate: AUDIO_BITRATE }),
    })
    output.addAudioTrack(audioSource)
    await output.start()

    const state: PumpState = {
      lastVideoTsSec: -1,
      nextFrameTsSec: 0,
      outputOffsetSec: 0,
      doneMs: 0,
      frameCount: 0,
      lastPreviewAtMs: 0,
    }

    const clipsInPlan = plan.segments.map((s) => s.clip)
    const multiDay = clipsSpanMultipleDays(clipsInPlan)
    const chapters: Mp4Chapter[] = []

  // Background music: playlist tracks are decoded lazily (one at a time,
  // released as the timeline passes them) and BLENDED with each segment's
  // audio slice under two per-segment envelopes — the clip's own sound
  // rides its clip-volume envelope and the music rides its music-volume
  // envelope (scaling the playing track's own volume). Both sources are
  // peak-normalized first so the dials mean the same thing regardless of
  // how hot either recording is. Envelopes are built from each segment's
  // REAL (clamped) duration as it is mixed, so ramps and fades stay on
  // their clips even when clamping shifts the timeline; only ramp-length
  // clamping peeks at the next clip's planned duration.
  const backgroundMixer =
    background && background.tracks.length > 0
      ? createBackgroundMixer(
          {
            trackCount: background.tracks.length,
            getTrack: async (index) => {
              const buffer = await decodeBackgroundAudio(
                background.tracks[index].blob,
                AUDIO_SAMPLE_RATE,
              )
              if (!buffer) return null
              const channels = Array.from(
                { length: buffer.numberOfChannels },
                (_, ch) => buffer.getChannelData(ch),
              )
              // Normalize the track in place (the decode is private) over
              // the WHOLE file, not just the kept window — a track's
              // loudness must not change with where it is trimmed.
              const scale = normalizationScale(channelPeak(channels))
              if (scale !== 1) {
                for (const data of channels) {
                  for (let i = 0; i < data.length; i += 1) data[i] *= scale
                }
              }
              // Only the kept (trimmed) window plays; the next track
              // starts where it ends.
              const playback = resolveAudioTrackPlayback(background.tracks[index], background)
              const startFrame = Math.min(
                channels[0].length,
                Math.round((playback.trimStartMs / 1000) * AUDIO_SAMPLE_RATE),
              )
              const endFrame = Number.isFinite(playback.trimEndMs)
                ? Math.min(
                    channels[0].length,
                    Math.round((playback.trimEndMs / 1000) * AUDIO_SAMPLE_RATE),
                  )
                : channels[0].length
              if (endFrame <= startFrame) return null
              if (startFrame === 0 && endFrame === channels[0].length) return channels
              return channels.map((data) => data.subarray(startFrame, endFrame))
            },
            getTrackPlayback: (index) => {
              const playback = resolveAudioTrackPlayback(background.tracks[index], background)
              return {
                volume: playback.volume,
                fadeIn: playback.fadeIn,
                fadeOut: playback.fadeOut,
              }
            },
            totalFrames: Math.round((plan.totalMs / 1000) * AUDIO_SAMPLE_RATE),
          },
          AUDIO_SAMPLE_RATE,
        )
      : null
  /** Film-edge fades come from the tracks at the film's edges. */
  const backgroundEdgeFades = background ? filmEdgeFades(background, plan.totalMs) : null
  const plannedDurationsMs = plan.segments.map((s) => s.endMs - s.startMs)
  /** Volumes + real duration of the previous EMITTED segment (dropped
   * segments must not become ramp anchors). */
  let previousSegment: {
    musicVolume: number
    clipVolume: number
    durationMs: number
  } | null = null
  /** Tail withheld from the previous EMITTED segment for the joint
   * crossfade (see segment-audio.ts); null until a segment emits. */
  let crossfadeCarry: Float32Array[] | null = null
  /** Audio frames actually appended. At a joint the audio buffer boundary
   * sits half a crossfade before the video cut, so this can differ from
   * outputOffsetSec by CROSSFADE_HALF_MS — the music mixer needs the real
   * audio position. */
  let audioFramesWritten = 0

  try {
    for (const [segmentIndex, segment] of plan.segments.entries()) {
      const isImage = isImageClip(segment.clip)
      const input = isImage
        ? null
        : new Input({
            source: new BlobSource(segment.clip.blob),
            formats: ALL_FORMATS,
          })

      let loaded: Awaited<ReturnType<typeof loadClipVideo>> | null = null
      try {
        let clamped: { startMs: number; endMs: number } | null
        if (isImage || !input) {
          // A photo has no media length to clamp against — its chosen
          // duration is exact by definition.
          clamped = { startMs: segment.startMs, endMs: segment.endMs }
        } else {
          const mediaDurationMs = await input
            .computeDuration()
            .then((seconds) => Math.round(seconds * 1000))
            .catch(() => 0)
          clamped = mediaDurationMs > 0 ? clampSegmentToMedia(segment, mediaDurationMs) : null
          if (!clamped) {
            try {
              loaded = await loadClipVideo(segment.clip.blob, 8000, segment.clip.mimeType)
              clamped = clampSegmentToMedia(segment, loaded.mediaDurationMs)
            } catch (error) {
              // A stubborn element load (iOS WebKit can refuse a blob it
              // recorded itself — KODY-VIDEO-A) must not kill the export when
              // it was only measuring duration: the recorder already measured
              // this clip's real media duration at capture time. Only the
              // element PUMP truly needs the element.
              clamped = clampSegmentToMedia(segment, segment.clip.durationMs)
              if (!clamped) {
                throw tagExportError(error, {
                  engine: 'webcodecs',
                  where: 'clip-duration',
                  clipIndex: segmentIndex,
                })
              }
            }
          }
        }
        if (!clamped) continue
        const segmentMs = clamped.endMs - clamped.startMs
        const hasNext = segmentIndex < plan.segments.length - 1
        // Each joint overlaps the neighbors' audio for CROSSFADE_HALF_MS on
        // both sides of the cut; the video gives up that half on each side
        // (sub-frame at 30fps) so the timeline matches the overlapped audio.
        const headChopMs = crossfadeCarry ? CROSSFADE_HALF_MS : 0
        const tailChopMs = hasNext ? CROSSFADE_HALF_MS : 0

        if (choice.container === 'mp4') {
          chapters.push({
            startMs: Math.round(state.outputOffsetSec * 1000),
            title: formatChapterTitle(segment.clip, multiDay, includeLocation),
          })
        }

        // Audio first: decoded per clip, sliced to the exact segment window
        // (silence-padded), appended sequentially — timestamps are implied
        // by position, so segments can never drift. Adjacent segments
        // CROSSFADE at the joint: the previous slice withheld its tail, and
        // this slice mixes it into its own head (see segment-audio.ts).
        // Photos are silent by construction — a null source slices to
        // silence without attempting an audio decode on image bytes.
        const buffer = isImage
          ? null
          : await decodeClipAudio(segment.clip.blob, AUDIO_SAMPLE_RATE)
        const sourceChannels = buffer
          ? Array.from({ length: buffer.numberOfChannels }, (_, ch) =>
              buffer.getChannelData(ch),
            )
          : null
        const { channels: sliceChannels, carryOut } = sliceSegmentAudio({
          source: sourceChannels,
          startMs: clamped.startMs,
          segmentMs,
          sampleRate: AUDIO_SAMPLE_RATE,
          channelCount: AUDIO_CHANNELS,
          carryIn: crossfadeCarry,
          hasNext,
        })
        crossfadeCarry = carryOut
        // Per-clip levels + normalization apply with or without music.
        const musicVolume = clipMusicVolume(segment.clip)
        const clipVolume = clipSoundVolume(segment.clip)
        // Whole-clip peak (not just this trim window) so a clip's
        // loudness doesn't change with where it is trimmed. The persisted
        // measurement (same decode + scan at the same rate) is preferred —
        // it skips a per-segment full scan and keeps the export's gain
        // identical to what the previews played.
        const foregroundScale = normalizationScale(
          segment.clip.audioPeak ?? (sourceChannels ? channelPeak(sourceChannels) : 0),
        )
        // The slice's real span (joints shift it by half a crossfade).
        const sliceDurationMs = (sliceChannels[0]!.length / AUDIO_SAMPLE_RATE) * 1000
        const nextPlanned = plan.segments[segmentIndex + 1]
        // Ramp halves clamp to the REAL clamped durations on both known
        // sides; only the exit peeks at the next clip's PLANNED duration
        // (its real one isn't measured yet).
        const entryHalfMs = previousSegment
          ? boundaryRampHalfMs(previousSegment.durationMs, segmentMs)
          : 0
        const exitHalfMs = nextPlanned
          ? boundaryRampHalfMs(segmentMs, plannedDurationsMs[segmentIndex + 1])
          : 0
        const clipEnvelope = planSegmentGain({
          volume: clipVolume,
          durationMs: sliceDurationMs,
          entry: previousSegment
            ? { fromVolume: previousSegment.clipVolume, halfMs: entryHalfMs }
            : undefined,
          exit: nextPlanned
            ? { toVolume: clipSoundVolume(nextPlanned.clip), halfMs: exitHalfMs }
            : undefined,
          fades: 'hold',
        })
        if (backgroundMixer && background) {
          await backgroundMixer.mixInto(
            sliceChannels,
            // Frames already written = the real position of this slice, even
            // when clamping shortened an earlier segment.
            audioFramesWritten,
            {
              music: planSegmentGain({
                volume: musicVolume,
                durationMs: sliceDurationMs,
                entry: previousSegment
                  ? { fromVolume: previousSegment.musicVolume, halfMs: entryHalfMs }
                  : undefined,
                exit: nextPlanned
                  ? { toVolume: clipMusicVolume(nextPlanned.clip), halfMs: exitHalfMs }
                  : undefined,
                fades: backgroundEdgeFades ?? background,
              }),
              clip: clipEnvelope,
            },
            foregroundScale,
          )
        } else {
          applyGainEnvelope(sliceChannels, clipEnvelope, AUDIO_SAMPLE_RATE, foregroundScale)
        }
        previousSegment = { musicVolume, clipVolume, durationMs: segmentMs }
        await audioSource.add(toAudioBuffer(sliceChannels))
        audioFramesWritten += sliceChannels[0]!.length

        const pumpShared: PumpSharedArgs = {
          startSec: (clamped.startMs + headChopMs) / 1000,
          endSec: (clamped.endMs - tailChopMs) / 1000,
          canvas,
          ctx,
          videoSource,
          state,
          // No mirroring needed when the encode canvas is the preview.
          getPreviewCanvas: encodingIntoPreview ? undefined : getPreviewCanvas,
          watermarkImage,
          onElapsedMs: (elapsed: number) => {
            if (plan.totalMs > 0) {
              onProgress?.(Math.min(1, (state.doneMs + elapsed) / plan.totalMs))
            }
          },
        }

        if (isImage || !input) {
          try {
            await pumpSegmentImage({ blob: segment.clip.blob, ...pumpShared })
          } catch (error) {
            throw tagExportError(error, {
              engine: 'webcodecs',
              where: 'image-pump',
              clipIndex: segmentIndex,
            })
          }
        } else {
          let pumped = false
          const outcome = await pumpSegmentVideoDecoded({ input, ...pumpShared })
          pumped = outcome === 'done'
          if (!pumped) {
            // Per-clip fallback: undecodable/unsupported clips play through a
            // video element like before (realtime-paced, but correct).
            console.info('[export] segment video path: element (realtime-paced)')
            try {
              loaded ??= await loadClipVideo(segment.clip.blob, 8000, segment.clip.mimeType)
            } catch (error) {
              throw tagExportError(error, {
                engine: 'webcodecs',
                where: 'element-pump',
                clipIndex: segmentIndex,
              })
            }
            await pumpSegmentVideo({ video: loaded.video, ...pumpShared })
          }
        }

        state.outputOffsetSec += (segmentMs - headChopMs - tailChopMs) / 1000
        state.doneMs += segmentMs
        onProgress?.(plan.totalMs > 0 ? Math.min(1, state.doneMs / plan.totalMs) : 1)
      } finally {
        loaded?.release()
      }
    }

    if (crossfadeCarry) {
      // Every planned segment after the last emitted one was dropped at
      // encode time, so the joint its tail was withheld for never happened:
      // emit the tail so the audio track ends exactly where the video does.
      await audioSource.add(toAudioBuffer(flushCarry(crossfadeCarry, AUDIO_SAMPLE_RATE)))
    }

    if (state.lastVideoTsSec < 0) {
      throw new Error('No video frames could be exported')
    }

    await output.finalize()
  } catch (error) {
    await output.cancel().catch(() => undefined)
    await opfs?.discard().catch(() => undefined)
    throw error
  }

  onProgress?.(1)
  const mimeType = choice.container === 'mp4' ? 'video/mp4' : 'video/webm'
  let blob: Blob
  if (opfs) {
    const file = await opfs.getFile()
    if (file.size === 0) throw new Error('Export produced no data')
    // Blob composition references the disk-backed file — no RAM copy.
    blob = new Blob([file], { type: mimeType })
  } else {
    const buffer = (output.target as BufferTarget).buffer
    if (!buffer) throw new Error('Export produced no data')
    blob = new Blob([buffer], { type: mimeType })
  }
  const diskBlob = blob
  let locationIncluded = false
  if (choice.container === 'mp4') {
    const metadata = await injectMetadataBestEffort(
      blob,
      mimeType,
      chapters,
      clipsInPlan,
      includeLocation,
    )
    blob = metadata.blob
    locationIncluded = metadata.locationIncluded
  }
  return {
    blob,
    mimeType,
    fileExtension: choice.container,
    locationIncluded,
    engine: 'webcodecs',
    opfsName: opfs?.name,
    // Metadata injection returns a NEW in-memory blob; when it ran, the
    // on-disk file no longer matches what the user gets.
    opfsBacked: opfs !== null && blob === diskBlob,
  }
  } finally {
    encodeCanvas.release()
  }
}

/** Metadata injection needs the whole file in memory (once) — worth it for
 * chapters/geotags on normal exports, but never worth risking a very long
 * export over: oversized files skip it, and any failure returns the
 * perfectly playable un-injected file. */
const METADATA_INJECT_LIMIT_BYTES = 256 * 1024 * 1024

async function injectMetadataBestEffort(
  blob: Blob,
  mimeType: string,
  chapters: Mp4Chapter[],
  clipsInPlan: ClipRecord[],
  includeLocation: boolean,
): Promise<{ blob: Blob; locationIncluded: boolean }> {
  if (blob.size > METADATA_INJECT_LIMIT_BYTES) {
    return { blob, locationIncluded: false }
  }
  try {
    const location = locationForExport(clipsInPlan, includeLocation)
    const source = await blob.arrayBuffer()
    const injected = injectMp4Metadata(source, {
      chapters,
      location,
    })
    return {
      blob: new Blob([injected], { type: mimeType }),
      locationIncluded: location !== null && injected !== source,
    }
  } catch {
    return { blob, locationIncluded: false }
  }
}

/** Output dimensions from the first clip's real (rotated) display size,
 * forced into the project's orientation when it carries one. */
async function probeOutputSize(
  plan: ExportPlan,
  orientation?: ProjectOrientation,
): Promise<{ width: number; height: number }> {
  const clip = plan.segments[0]!.clip
  if (isImageClip(clip)) {
    // Photos store their pixel size at import; a decode is the fallback.
    if ((clip.width ?? 0) > 0 && (clip.height ?? 0) > 0) {
      return pickOutputSize(clip.width!, clip.height!, orientation)
    }
    try {
      const bitmap = await loadClipImage(clip.blob)
      try {
        return pickOutputSize(bitmap.width, bitmap.height, orientation)
      } finally {
        bitmap.close()
      }
    } catch (error) {
      throw tagExportError(error, { engine: 'webcodecs', where: 'probe-size', clipIndex: 0 })
    }
  }
  try {
    const input = new Input({ source: new BlobSource(clip.blob), formats: ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (track && track.displayWidth > 0 && track.displayHeight > 0) {
      return pickOutputSize(track.displayWidth, track.displayHeight, orientation)
    }
  } catch {
    // Fall through to the element probe.
  }
  try {
    const probe = await loadClipVideo(clip.blob, 8000, clip.mimeType)
    try {
      return pickOutputSize(probe.video.videoWidth, probe.video.videoHeight, orientation)
    } finally {
      probe.release()
    }
  } catch (error) {
    // Recorded clips carry their capture dimensions — probing must never be
    // the reason an export dies (pickOutputSize also has sane defaults).
    if ((clip.width ?? 0) > 0 && (clip.height ?? 0) > 0) {
      return pickOutputSize(clip.width!, clip.height!, orientation)
    }
    throw tagExportError(error, { engine: 'webcodecs', where: 'probe-size', clipIndex: 0 })
  }
}


interface PumpState {
  lastVideoTsSec: number
  /** Next 30fps output-clock tick; frames arriving before it are dropped. */
  nextFrameTsSec: number
  outputOffsetSec: number
  doneMs: number
  frameCount: number
  lastPreviewAtMs: number
}

interface PumpSharedArgs {
  startSec: number
  endSec: number
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  videoSource: CanvasSource
  state: PumpState
  getPreviewCanvas?: () => HTMLCanvasElement | null
  watermarkImage?: HTMLImageElement | null
  onElapsedMs: (elapsedMs: number) => void
}

/** Compose one source frame onto the encode canvas and hand it to the
 * encoder at its rebased output timestamp — the heart of both pumps.
 * Awaiting the returned promise applies encoder backpressure. */
function makeFrameSink({
  startSec,
  endSec,
  canvas,
  ctx,
  videoSource,
  state,
  getPreviewCanvas,
  watermarkImage,
}: PumpSharedArgs) {
  return (
    draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
    mediaTimeSec: number,
    options?: { force?: boolean },
  ): Promise<void> => {
    const clampedSec = Math.min(Math.max(mediaTimeSec, startSec), endSec)
    let tsSec = state.outputOffsetSec + (clampedSec - startSec)
    // Decimate against the output clock: emit one frame per 30fps tick and
    // drop the rest, so ANY source rate (40, 60, 120fps) caps at exactly
    // FPS long-run — a fixed minimum gap would let a 40fps source through
    // untouched. Segment anchor frames are forced: every segment must
    // contribute at least its first frame.
    if (!options?.force && tsSec < state.nextFrameTsSec - DECIMATE_TOLERANCE_SEC) {
      return Promise.resolve()
    }
    // Stay on the tick grid while the source keeps up; resync from the
    // frame itself across gaps (slow sources, segment jumps).
    state.nextFrameTsSec = Math.max(state.nextFrameTsSec, tsSec) + FRAME_INTERVAL_SEC
    if (tsSec <= state.lastVideoTsSec) {
      tsSec = state.lastVideoTsSec + 0.001
    }
    draw(ctx, canvas.width, canvas.height)
    if (watermarkImage) {
      drawWatermark(ctx, watermarkImage, canvas.width, canvas.height)
    }
    state.lastVideoTsSec = tsSec
    // Wall-clock throttled: the decoded pump can process frames far faster
    // than realtime, so per-frame-count sampling would burn time blitting.
    const now = performance.now()
    if (now - state.lastPreviewAtMs >= PREVIEW_INTERVAL_MS) {
      state.lastPreviewAtMs = now
      blitPreview(canvas, getPreviewCanvas?.())
    }
    if (state.frameCount % 30 === 0) {
      recordVideoLumaSample(canvas)
    }
    state.frameCount += 1
    return videoSource.add(tsSec, 1 / FPS)
  }
}

interface DecodedPumpArgs extends PumpSharedArgs {
  input: Input
}

/**
 * Decode-driven pump: Mediabunny's CanvasSink demuxes and decodes the
 * clip's own samples (B-frame ordering, decoder configs, and the file's
 * rotation metadata all handled by the library) and yields frames already
 * cover-fitted to the output size. Returns 'unsupported' (caller falls
 * back to the element pump) only when nothing was emitted yet; a failure
 * after frames were encoded aborts the whole export instead — falling back
 * then would duplicate content.
 */
async function pumpSegmentVideoDecoded(
  args: DecodedPumpArgs,
): Promise<'done' | 'unsupported'> {
  const { input, startSec, endSec, canvas, onElapsedMs } = args
  const emit = makeFrameSink(args)

  let track
  try {
    track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) return 'unsupported'
  } catch {
    return 'unsupported'
  }

  const sink = new CanvasSink(track, {
    width: canvas.width,
    height: canvas.height,
    fit: 'cover',
    poolSize: 2,
  })

  let framesEmitted = 0
  try {
    // Long segments on slow decoders still finish well inside this; a
    // wedged decoder must not hang the export forever.
    const deadline = performance.now() + Math.max(120_000, (endSec - startSec) * 5000)
    for await (const wrapped of sink.canvases(startSec, endSec)) {
      if (performance.now() > deadline) {
        throw new Error('Export decode stalled')
      }
      // Anchor each segment's first frame to the exact segment start:
      // clips whose first sample presents late (B-frame reorder delay,
      // edit lists) must not shift the timeline — and the container's
      // first chunk must sit at 0.
      const mediaSec = framesEmitted === 0 ? startSec : wrapped.timestamp
      await emit((ctx) => ctx.drawImage(wrapped.canvas, 0, 0), mediaSec, {
        force: framesEmitted === 0,
      })
      framesEmitted += 1
      onElapsedMs((Math.min(wrapped.timestamp, endSec) - startSec) * 1000)
    }
  } catch (err) {
    if (framesEmitted > 0) {
      throw err instanceof Error ? err : new Error('Decoded video pump failed')
    }
    return 'unsupported'
  }

  if (framesEmitted === 0) return 'unsupported'
  return 'done'
}

interface ImagePumpArgs extends PumpSharedArgs {
  blob: Blob
}

/**
 * Photo pump: decode the still once and emit it on every 30fps output tick
 * across the segment — the encoder sees a regular constant-rate stream, so
 * photos and videos concatenate seamlessly. Runs at hardware speed (the
 * only per-frame cost is the canvas draw + encode).
 */
async function pumpSegmentImage({ blob, ...shared }: ImagePumpArgs): Promise<void> {
  const { startSec, endSec, onElapsedMs } = shared
  const emit = makeFrameSink(shared)
  const bitmap = await loadClipImage(blob)
  try {
    const draw = (ctx: CanvasRenderingContext2D, width: number, height: number) =>
      drawCoverFrom(ctx, bitmap, bitmap.width, bitmap.height, width, height)
    // The epsilon keeps float accumulation from emitting one tick past the
    // segment's end (the sink would clamp it onto the same timestamp).
    for (let tsSec = startSec, first = true; tsSec < endSec - 1e-6; tsSec += FRAME_INTERVAL_SEC) {
      await emit(draw, tsSec, { force: first })
      first = false
      onElapsedMs((tsSec - startSec) * 1000)
    }
  } finally {
    bitmap.close()
  }
}

interface PumpArgs extends PumpSharedArgs {
  video: HTMLVideoElement
}

/**
 * Element-pump fallback for clips WebCodecs cannot decode: plays the clip
 * muted and captures composited frames. Realtime-paced by nature — only
 * used when the decoded pump can't run.
 */
async function pumpSegmentVideo({
  video,
  ...shared
}: PumpArgs): Promise<void> {
  const { startSec, endSec, onElapsedMs } = shared
  await seekTo(video, startSec)

  const emit = makeFrameSink(shared)
  // The draw happens SYNCHRONOUSLY at callback time (frame and timestamp
  // must belong together); the returned promise carries encoder
  // backpressure and paces when the next frame is processed.
  const emitAt = (mediaTimeSec: number, options?: { force?: boolean }): Promise<void> =>
    emit(
      (ctx, width, height) => {
        const vw = video.videoWidth || width
        const vh = video.videoHeight || height
        const scale = Math.max(width / vw, height / vh)
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, width, height)
        ctx.drawImage(
          video,
          (width - vw * scale) / 2,
          (height - vh * scale) / 2,
          vw * scale,
          vh * scale,
        )
      },
      mediaTimeSec,
      options,
    )

  // Guarantee at least one frame per segment, even if playback ends instantly.
  await emitAt(startSec, { force: true })

  const supportsRvfc = typeof video.requestVideoFrameCallback === 'function'

  await video.play()

  try {
    await new Promise<void>((resolve, reject) => {
      let finished = false
      let lastProgressAt = performance.now()
      let lastMediaTime = startSec
      let rafId = 0
      let watchdogId = 0

      const finish = () => {
        if (finished) return
        finished = true
        window.clearInterval(watchdogId)
        if (rafId) cancelAnimationFrame(rafId)
        video.pause()
        resolve()
      }
      const abort = (err: Error) => {
        if (finished) return
        finished = true
        window.clearInterval(watchdogId)
        if (rafId) cancelAnimationFrame(rafId)
        video.pause()
        reject(err)
      }

      const handleFrame = (mediaTimeSec: number) => {
        if (finished) return
        if (mediaTimeSec > lastMediaTime + 0.001) {
          lastMediaTime = mediaTimeSec
          lastProgressAt = performance.now()
        }
        if (video.ended || mediaTimeSec >= endSec - 0.005) {
          finish()
          return
        }
        if (mediaTimeSec > startSec) {
          // Draw now (synchronously — this frame belongs to this timestamp),
          // then let the encoder's backpressure pace the next callback.
          // While it drains, playback continues and frames are skipped —
          // realtime-fallback semantics, same as pausing would produce.
          onElapsedMs((mediaTimeSec - startSec) * 1000)
          emitAt(mediaTimeSec).then(scheduleNext, (err) => {
            abort(err instanceof Error ? err : new Error('Export encoder failed'))
          })
          return
        }
        scheduleNext()
      }

      const scheduleNext = () => {
        if (finished) return
        if (supportsRvfc) {
          video.requestVideoFrameCallback((_now, metadata) => {
            handleFrame(metadata.mediaTime)
          })
        } else {
          rafId = requestAnimationFrame(() => {
            handleFrame(video.currentTime)
          })
        }
      }

      video.onended = finish
      video.onerror = () => abort(new Error('A clip failed to play during export'))
      watchdogId = window.setInterval(() => {
        if (performance.now() - lastProgressAt > 10_000) {
          abort(new Error('Clip playback stalled during export'))
        }
      }, 1000)
      scheduleNext()
    })
  } finally {
    video.onended = null
    video.onerror = null
  }
}

/** Wrap raw channel data in an AudioBuffer for the encoder. */
function toAudioBuffer(channels: Float32Array[]): AudioBuffer {
  const buffer = new AudioBuffer({
    length: channels[0]!.length,
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: channels.length,
  })
  channels.forEach((data, ch) => buffer.copyToChannel(data, ch))
  return buffer
}
