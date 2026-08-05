import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { planExport } from '../lib/export'
import { FADE_OUT_MS } from '../lib/export/background-audio'
import {
  clipElementVolume,
  measureAudioNormalization,
  musicElementVolume,
  peekAudioNormalization,
} from '../lib/preview-audio-normalization'
import {
  clipAudioVolume,
  type ClipRecord,
  type ProjectAudioRecord,
  type ProjectAudioTrack,
} from '../lib/types'
import { IconPlay } from './icons'
import { isInteractiveTarget } from '../lib/keyboard'

interface PlaybackOverlayProps {
  clips: ClipRecord[]
  /** Background-music track played under the clips (null when none). */
  audio: ProjectAudioRecord | null
  onClose: () => void
}

/** Smoothing time constant for music volume moves (~settles in 3×). */
const MUSIC_VOLUME_TAU_MS = 200

/**
 * Sequential project preview, OK Video style: one persistent video element
 * (so unmuted playback stays allowed across clips), tap the left/right edges
 * for previous/next clip, tap the middle to stop.
 */
export function PlaybackOverlay(handle: Handle<PlaybackOverlayProps>) {
  const { props } = handle

  // Cached per clips identity so segment identity is stable across progress
  // re-renders — otherwise the video source would rebind (revoking and
  // reassigning the blob URL) on every tick and playback would restart.
  let planFor: ClipRecord[] | null = null
  let segments: ReturnType<typeof planExport>['segments'] = []
  const resolveSegments = () => {
    if (planFor !== props.clips) {
      planFor = props.clips
      segments = planExport(props.clips).segments
    }
    return segments
  }

  let index = 0
  let needsTap = false
  let segmentProgress = 0
  let videoEl: HTMLVideoElement | null = null
  const urlState: { url: string | null; blob: Blob | null } = { url: null, blob: null }
  let advancedFor = -1
  /** Index whose media has actually loaded — gates stale timeupdate/ended
   * events from the previous clip that fire before the new source is ready. */
  let loadedIndex = -1

  // Background music: one audio element under the whole preview, playing
  // the playlist's tracks one after the other (nothing loops — when the
  // playlist runs out the rest of the preview is music-free). Its volume
  // glides toward the current clip's music volume every frame, so
  // transitions between clips ramp instead of jumping — the same behavior
  // the export renders, heard live.
  let audioEl: HTMLAudioElement | null = null
  /** Lazily created object URL per playlist track (revoked on unmount). */
  const trackUrls = new Map<number, string>()
  let musicTrackIndex = -1
  /** True once the LAST track actually finished playing — decoded audio can
   * end before its stored metadata duration, and the clip's own sound must
   * come back up as soon as the music is really over, not when the
   * metadata window says so. Cleared when a skip seeks music again. */
  let playlistDone = false

  // Export-fidelity levels: the export peak-normalizes BOTH sources toward
  // the same peak before blending by the mix share (a quietly mastered song
  // is boosted up to 4×). The previews carry those measured scales through
  // plain element volumes, clamped to the ceiling of 1 — deliberately NOT
  // through a Web Audio media-element graph, whose captured elements go
  // permanently silent on WebKit/iOS whenever the context is not running.
  // See preview-audio-normalization.ts for the trade-off.

  /** Normalization gain the export applies to this source (1 until the
   * background measurement lands). */
  const scaleFor = (blob: Blob): number => peekAudioNormalization(blob)?.scale ?? 1

  /** Track length on the output timeline. The export hands off to the next
   * playlist track where the previous one's DECODED samples end, which can
   * differ from the stored metadata duration — prefer the measured value. */
  const trackDurationMs = (track: ProjectAudioTrack): number =>
    peekAudioNormalization(track.blob)?.decodedDurationMs ?? track.durationMs

  /** A rejected play() surfaces the tap-to-play affordance only for
   * autoplay-policy rejections. AbortError means the attempt was merely
   * interrupted — a deliberate pause() or a source swap landing while the
   * promise was still pending — and flashing "Tap to play" over the
   * controls then is wrong (and blocks the button underneath). */
  const rejectionNeedsTap = (error: unknown): boolean =>
    !(error instanceof DOMException && error.name === 'AbortError')

  const currentSegment = () => resolveSegments()[index] ?? null
  const startSec = () => {
    const segment = currentSegment()
    return segment ? segment.startMs / 1000 : 0
  }
  const endSec = () => {
    const segment = currentSegment()
    return segment ? segment.endMs / 1000 : 0
  }
  const segmentMs = () => {
    const segment = currentSegment()
    return segment ? segment.endMs - segment.startMs : 0
  }

  const segmentMusicVolume = () => {
    const segment = currentSegment()
    const track = props.audio
    if (!segment || !track) return 0
    return clipAudioVolume(segment.clip, track.defaultVolume) * fadeOutScale()
  }

  /** Mirror the export's end-of-film fade-out in the live preview: inside
   * the final FADE_OUT_MS the music target scales down toward silence. */
  const fadeOutScale = () => {
    if (!props.audio?.fadeOut) return 1
    const segs = resolveSegments()
    const last = segs[segs.length - 1]
    if (!last) return 1
    const totalMs = last.offsetMs + (last.endMs - last.startMs)
    const remainingMs = totalMs - timelinePositionMs()
    return Math.max(0, Math.min(1, remainingMs / FADE_OUT_MS))
  }

  /** Playhead position on the output timeline, in ms. */
  const timelinePositionMs = () => {
    const segment = currentSegment()
    if (!segment) return 0
    const elapsedSec = videoEl ? Math.max(0, videoEl.currentTime - segment.startMs / 1000) : 0
    return segment.offsetMs + elapsedSec * 1000
  }

  /** Playlist track and in-track offset covering an output position, or
   * null when the playlist has already run out there. */
  const trackAtMs = (positionMs: number): { index: number; offsetMs: number } | null => {
    const tracks = props.audio?.tracks ?? []
    let cursor = 0
    for (let i = 0; i < tracks.length; i += 1) {
      if (positionMs < cursor + trackDurationMs(tracks[i])) {
        return { index: i, offsetMs: positionMs - cursor }
      }
      cursor += trackDurationMs(tracks[i])
    }
    return null
  }

  const urlForTrack = (trackIndex: number): string => {
    let url = trackUrls.get(trackIndex)
    if (!url) {
      url = URL.createObjectURL(props.audio!.tracks[trackIndex].blob)
      trackUrls.set(trackIndex, url)
    }
    return url
  }

  /** Put the right playlist track under the playhead. Small drift within a
   * track is left alone — a re-seek every segment would audibly hiccup
   * continuous playback. Returns false when there is no music to play. */
  const syncMusicPosition = (): boolean => {
    const audio = audioEl
    if (!audio || !props.audio) return false
    const positionMs = timelinePositionMs()
    const target = trackAtMs(positionMs)
    if (!target) {
      audio.pause()
      return false
    }
    if (musicTrackIndex !== target.index) {
      // Metadata durations can run slightly past the decoded length, so a
      // just-ended track briefly still "covers" the playhead — moving back
      // to it mid-playback would restart it. The guard protects that
      // playback continuity only, and only while the covering track's REAL
      // (decoded) length is unknown: once measured, every position mapped
      // into the track is backed by real audio, so realigning to it is
      // always safe (and export-true — the export is still playing that
      // track's tail there). Once the current element has ENDED there is
      // also nothing to protect (play() on it would restart it from 0),
      // so a backward skip switches to the covering track instead.
      const boundaryMs = props.audio.tracks
        .slice(0, target.index + 1)
        .reduce((sum, track) => sum + trackDurationMs(track), 0)
      const overshootPossible =
        peekAudioNormalization(props.audio.tracks[target.index].blob)?.decodedDurationMs == null
      const nearHandOff =
        overshootPossible &&
        target.index < musicTrackIndex &&
        boundaryMs - positionMs < 1500 &&
        !audio.ended
      if (!nearHandOff) {
        musicTrackIndex = target.index
        audio.src = urlForTrack(target.index)
        audio.currentTime = target.offsetMs / 1000
        playlistDone = false
      }
      return true
    }
    const expectedSec = target.offsetMs / 1000
    // Positions inside a finished track's metadata overshoot have no
    // decoded audio behind them — playing there would RESTART the ended
    // element (play() on an ended media element seeks back to 0).
    const decodedEndSec = Number.isFinite(audio.duration) ? audio.duration : Infinity
    if (playlistDone && expectedSec >= decodedEndSec - 0.05) {
      return false
    }
    if (Math.abs(audio.currentTime - expectedSec) > 0.35) {
      audio.currentTime = expectedSec
      // A genuine seek into real decoded audio — music is live again.
      playlistDone = false
    }
    return true
  }

  /** A track finished — hand off to the next one (never replay the ended
   * track: metadata duration may outlast the decoded audio, so a
   * position-based sync could still map into it). */
  const advanceMusicTrack = () => {
    const tracks = props.audio?.tracks ?? []
    const audio = audioEl
    if (!audio) return
    const next = musicTrackIndex + 1
    if (next >= tracks.length) {
      // Playlist over — the rest is music-free (and the clip's own sound
      // comes back up right away, even inside the metadata overshoot).
      playlistDone = true
      return
    }
    musicTrackIndex = next
    audio.src = urlForTrack(next)
    audio.currentTime = 0
    if (videoEl && !videoEl.paused) void audio.play().catch(() => undefined)
  }

  const playMusic = () => {
    if (!syncMusicPosition()) return
    void audioEl?.play().catch(() => undefined)
  }

  const pauseMusic = () => {
    audioEl?.pause()
  }

  const bindAudio = (el: HTMLAudioElement, signal: AbortSignal) => {
    const track = props.audio
    if (!track) return
    audioEl = el
    // No fade-in means the music opens at the clip's mix level; otherwise
    // the per-frame glide below fades it in from silence. `mix` is the
    // export envelope's value (share × film-edge fades), tracked apart
    // from the element volume so the normalization scales can multiply on
    // top without distorting the glide.
    let mix = track.fadeIn ? 0 : segmentMusicVolume()
    el.volume = mix

    // Measure every source up front, one decode at a time: the scales and
    // decoded track lengths should be ready by the time the playhead needs
    // them (results are cached per blob, so reopening is instant).
    void (async () => {
      const blobs = [
        ...track.tracks.map((t) => t.blob),
        ...resolveSegments().map((segment) => segment.clip.blob),
      ]
      for (const blob of blobs) {
        if (audioEl !== el) return
        await measureAudioNormalization(blob)
        // A decoded track length that differs from the stored metadata
        // duration moves the playlist's boundaries — realign the bed to
        // the corrected (export-true) position right away instead of
        // waiting for the next skip. Guarded inside syncMusicPosition:
        // in-track drift under 350ms and imminent hand-offs are left
        // alone, so an accurate metadata duration re-seeks nothing.
        if (musicTrackIndex >= 0) syncMusicPosition()
      }
    })()

    // Per-frame glide of BOTH sides of the mix: the export envelope value
    // glides toward the current clip's share (0 where the playlist has run
    // out), and each element's volume is its side of the blend times its
    // source's normalization scale, clamped to the element ceiling.
    let last = performance.now()
    let raf = 0
    let reportedClipScale = ''
    let reportedMusicScale = ''
    const tick = (now: number) => {
      const dt = Math.min(100, now - last)
      last = now
      const musicHere =
        !playlistDone && trackAtMs(timelinePositionMs()) !== null
      const target = musicHere ? segmentMusicVolume() : 0
      const alpha = 1 - Math.exp(-dt / MUSIC_VOLUME_TAU_MS)
      const next = mix + (target - mix) * alpha
      mix = Math.abs(next - target) < 0.005 ? target : next
      const trackBlob = props.audio?.tracks[musicTrackIndex]?.blob
      const musicScale = trackBlob ? scaleFor(trackBlob) : 1
      el.volume = musicElementVolume(mix, musicScale)
      const video = videoEl
      const segment = currentSegment()
      const clipScale = segment ? scaleFor(segment.clip.blob) : 1
      if (video) {
        // The clip's own sound carries the complement of the CURRENT
        // (gliding) mix — during the fade-in it starts at full and only
        // comes down as the bed actually rises. After the playlist ends it
        // keeps its normalization, exactly like the export's foreground.
        video.volume = clipElementVolume(mix, clipScale)
      }
      // Test observability for the applied normalization scales.
      const clipScaleText = String(clipScale)
      if (clipScaleText !== reportedClipScale) {
        reportedClipScale = clipScaleText
        el.dataset.clipScale = clipScaleText
      }
      const musicScaleText = String(musicScale)
      if (musicScaleText !== reportedMusicScale) {
        reportedMusicScale = musicScaleText
        el.dataset.musicScale = musicScaleText
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    signal.addEventListener('abort', () => {
      cancelAnimationFrame(raf)
      el.pause()
      if (audioEl === el) audioEl = null
      for (const url of trackUrls.values()) URL.revokeObjectURL(url)
      trackUrls.clear()
      musicTrackIndex = -1
    })
  }

  /** Bind the current segment's blob to the persistent video element.
   * Returns whether a new source was assigned (i.e. `loadedmetadata` will
   * fire and drive playback). */
  const syncVideoSrc = (): boolean => {
    const el = videoEl
    const segment = currentSegment()
    if (!el || !segment) return false
    if (urlState.blob !== segment.clip.blob) {
      if (urlState.url) URL.revokeObjectURL(urlState.url)
      urlState.url = URL.createObjectURL(segment.clip.blob)
      urlState.blob = segment.clip.blob
      el.src = urlState.url
      return true
    }
    return false
  }

  const goTo = (nextIndex: number) => {
    advancedFor = -1
    segmentProgress = 0
    needsTap = false
    if (nextIndex === index) {
      const video = videoEl
      if (video) {
        video.currentTime = startSec()
        void video
          .play()
          .then(() => playMusic())
          .catch((error: unknown) => {
            if (!rejectionNeedsTap(error)) return
            needsTap = true
            void handle.update()
          })
      }
      void handle.update()
      return
    }
    index = Math.max(0, Math.min(resolveSegments().length - 1, nextIndex))
    // Jump the music to the new position now — waiting for the next clip's
    // metadata would leave the old position playing through the load gap.
    syncMusicPosition()
    void handle.update()
  }

  const advance = () => {
    if (advancedFor === index) return
    advancedFor = index
    if (index >= resolveSegments().length - 1) {
      props.onClose()
      return
    }
    segmentProgress = 0
    index = index + 1
    // Positionally a no-op (segments abut on the timeline), but keeps the
    // playlist hand-off logic on one path with manual skips.
    syncMusicPosition()
    void handle.update()
  }

  const startPlayback = (video: HTMLVideoElement) => {
    video.currentTime = startSec()
    void video
      .play()
      .then(() => {
        needsTap = false
        playMusic()
        void handle.update()
      })
      .catch((error: unknown) => {
        if (!rejectionNeedsTap(error)) return
        needsTap = true
        void handle.update()
      })
  }

  // Desktop keyboard support: arrows skip clips, Space pauses, Esc closes.
  const onWindowKeyDown = (event: KeyboardEvent) => {
    // Escape stays global; everything else yields to focused controls
    // (e.g. Space on a tab-focused skip button must click it).
    if (event.code !== 'Escape' && isInteractiveTarget(event)) return
    switch (event.code) {
      case 'Escape':
        props.onClose()
        return
      case 'ArrowLeft':
        event.preventDefault()
        if (index > 0) goTo(index - 1)
        return
      case 'ArrowRight':
        event.preventDefault()
        goTo(index + 1)
        return
      case 'Space': {
        event.preventDefault()
        // Auto-repeat while held must not rapid-toggle pause/resume.
        if (event.repeat) return
        const video = videoEl
        if (!video) return
        if (video.paused) {
          void video
            .play()
            .then(() => {
              needsTap = false
              playMusic()
              void handle.update()
            })
            .catch((error: unknown) => {
              if (!rejectionNeedsTap(error)) return
              needsTap = true
              void handle.update()
            })
        } else {
          video.pause()
          pauseMusic()
        }
        return
      }
      default:
        return
    }
  }

  const bindKeyboard = (_node: Element, signal: AbortSignal) => {
    window.addEventListener('keydown', onWindowKeyDown)
    signal.addEventListener('abort', () => {
      window.removeEventListener('keydown', onWindowKeyDown)
    })
  }

  const bindVideo = (el: HTMLVideoElement, signal: AbortSignal) => {
    videoEl = el
    syncVideoSrc()
    signal.addEventListener('abort', () => {
      videoEl = null
      if (urlState.url) URL.revokeObjectURL(urlState.url)
      urlState.url = null
      urlState.blob = null
    })
  }

  return () => {
    const segs = resolveSegments()
    const segment = segs[index] ?? null

    if (!segment) {
      return (
        <div
          key="playback-empty"
          className="playback-overlay"
          role="dialog"
          aria-label="Project preview"
          mix={ref(bindKeyboard)}
        >
          <p className="playback-empty">Nothing to play yet — record a clip first.</p>
          <button
            type="button"
            className="btn btn-secondary"
            mix={on('click', () => props.onClose())}
          >
            Close
          </button>
        </div>
      )
    }

    // Same blob as the previous segment = no new source, so `loadedmetadata`
    // never re-fires (adjacent duplicated clips) — start this segment
    // directly. Still-loading media (readyState 0) is left to loadedmetadata.
    if (!syncVideoSrc() && videoEl && videoEl.readyState >= 1 && loadedIndex !== index) {
      loadedIndex = index
      startPlayback(videoEl)
    }

    return (
      <div
        key="playback-active"
        className="playback-overlay"
        role="dialog"
        aria-label="Project preview"
        mix={ref(bindKeyboard)}
      >
        <div className="playback-progress" aria-hidden="true">
          {segs.map((seg, i) => (
            <span
              key={`${seg.clip.id}:${i}`}
              style={{ flexGrow: Math.max(1, seg.endMs - seg.startMs) }}
            >
              <i
                style={{
                  width:
                    i < index
                      ? '100%'
                      : i === index
                        ? `${Math.round(segmentProgress * 100)}%`
                        : '0%',
                }}
              />
            </span>
          ))}
        </div>

        {props.audio ? (
          <audio
            preload="auto"
            aria-hidden="true"
            mix={[
              ref((node, signal) => bindAudio(node as HTMLAudioElement, signal)),
              // A track running out mid-preview hands off to the next one.
              on('ended', () => advanceMusicTrack()),
            ]}
          />
        ) : null}

        <video
          className="playback-video"
          playsInline
          preload="auto"
          mix={[
            ref((node, signal) => bindVideo(node as HTMLVideoElement, signal)),
            on('loadedmetadata', (event) => {
              loadedIndex = index
              startPlayback(event.currentTarget as HTMLVideoElement)
            }),
            on('ended', () => {
              if (loadedIndex !== index) return
              advance()
            }),
            on('timeupdate', (event) => {
              if (loadedIndex !== index) return
              const video = event.currentTarget as HTMLVideoElement
              const elapsed = video.currentTime - startSec()
              segmentProgress = segmentMs() > 0 ? Math.min(1, (elapsed * 1000) / segmentMs()) : 0
              void handle.update()
              if (video.currentTime >= endSec() - 0.03) {
                video.pause()
                advance()
              }
            }),
          ]}
        />

        <div className="playback-tap-zones">
          <button
            type="button"
            aria-label="Previous clip"
            disabled={index === 0}
            mix={on('click', () => goTo(index - 1))}
          />
          <button type="button" aria-label="Stop preview" mix={on('click', () => props.onClose())} />
          <button type="button" aria-label="Next clip" mix={on('click', () => goTo(index + 1))} />
        </div>

        {needsTap ? (
          <button
            type="button"
            className="playback-resume"
            mix={on('click', () => {
              const video = videoEl
              if (video)
                void video
                  .play()
                  .then(() => {
                    needsTap = false
                    playMusic()
                    void handle.update()
                  })
                  .catch(() => undefined)
            })}
          >
            <IconPlay size={18} /> Tap to play
          </button>
        ) : null}

        <div className="playback-caption">
          Clip {index + 1} / {segs.length} · tap edges to skip · tap middle to stop
        </div>
      </div>
    )
  }
}
