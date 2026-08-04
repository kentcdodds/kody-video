import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { planExport } from '../lib/export'
import { clipAudioVolume, type ClipRecord, type ProjectAudioRecord } from '../lib/types'
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
    return clipAudioVolume(segment.clip, track.defaultVolume)
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
      if (positionMs < cursor + tracks[i].durationMs) {
        return { index: i, offsetMs: positionMs - cursor }
      }
      cursor += tracks[i].durationMs
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
    const target = trackAtMs(timelinePositionMs())
    if (!target) {
      audio.pause()
      return false
    }
    if (musicTrackIndex !== target.index) {
      musicTrackIndex = target.index
      audio.src = urlForTrack(target.index)
      audio.currentTime = target.offsetMs / 1000
    } else if (Math.abs(audio.currentTime - target.offsetMs / 1000) > 0.35) {
      audio.currentTime = target.offsetMs / 1000
    }
    return true
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
    // No fade-in means the music opens at full clip volume; otherwise the
    // per-frame glide below fades it in from silence.
    el.volume = track.fadeIn ? 0 : segmentMusicVolume()

    // Per-frame volume glide toward the current clip's target.
    let last = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const dt = Math.min(100, now - last)
      last = now
      const target = segmentMusicVolume()
      const alpha = 1 - Math.exp(-dt / MUSIC_VOLUME_TAU_MS)
      const next = el.volume + (target - el.volume) * alpha
      el.volume = Math.abs(next - target) < 0.005 ? target : next
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
          .catch(() => {
            needsTap = true
            void handle.update()
          })
      }
      void handle.update()
      return
    }
    index = Math.max(0, Math.min(resolveSegments().length - 1, nextIndex))
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
      .catch(() => {
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
            .catch(() => {
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
              on('ended', () => {
                if (videoEl && !videoEl.paused) playMusic()
              }),
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
