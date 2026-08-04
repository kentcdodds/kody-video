import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { planExport } from '../lib/export'
import type { ClipRecord } from '../lib/types'
import { IconPlay } from './icons'
import { isInteractiveTarget } from '../lib/keyboard'

interface PlaybackOverlayProps {
  clips: ClipRecord[]
  onClose: () => void
}

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
        void video.play().catch(() => {
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
              void handle.update()
            })
            .catch(() => {
              needsTap = true
              void handle.update()
            })
        } else {
          video.pause()
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
