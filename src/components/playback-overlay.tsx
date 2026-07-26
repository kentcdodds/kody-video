import { useCallback, useMemo, useRef, useState } from 'react'
import { planExport } from '../lib/export'
import type { ClipRecord } from '../lib/types'

interface PlaybackOverlayProps {
  clips: ClipRecord[]
  onClose: () => void
}

/**
 * Sequential project preview, OK Video style: one persistent video element
 * (so unmuted playback stays allowed across clips), tap the left/right edges
 * for previous/next clip, tap the middle to stop.
 */
export function PlaybackOverlay({ clips, onClose }: PlaybackOverlayProps) {
  // Memoized so segment identity is stable across progress re-renders —
  // otherwise the video ref callback re-binds (revoking and reassigning the
  // blob URL) on every tick and playback restarts.
  const plan = useMemo(() => planExport(clips), [clips])
  const segments = plan.segments

  const [index, setIndex] = useState(0)
  const [needsTap, setNeedsTap] = useState(false)
  const [segmentProgress, setSegmentProgress] = useState(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const urlStateRef = useRef<{ url: string | null; blob: Blob | null }>({ url: null, blob: null })
  const advancedForRef = useRef(-1)
  /** Index whose media has actually loaded — gates stale timeupdate/ended
   * events from the previous clip that fire before the new source is ready. */
  const loadedIndexRef = useRef(-1)

  const segment = segments[index] ?? null

  const bindVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      videoRef.current = el
      const state = urlStateRef.current
      if (!el) {
        if (state.url) URL.revokeObjectURL(state.url)
        state.url = null
        state.blob = null
        return
      }
      if (!segment) return
      if (state.blob !== segment.clip.blob) {
        if (state.url) URL.revokeObjectURL(state.url)
        state.url = URL.createObjectURL(segment.clip.blob)
        state.blob = segment.clip.blob
        el.src = state.url
      }
    },
    [segment],
  )

  if (!segment) {
    return (
      <div className="playback-overlay" role="dialog" aria-label="Project preview">
        <p className="playback-empty">Nothing to play yet — record a clip first.</p>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    )
  }

  const startSec = segment.startMs / 1000
  const endSec = segment.endMs / 1000
  const segmentMs = segment.endMs - segment.startMs

  const goTo = (nextIndex: number) => {
    advancedForRef.current = -1
    setSegmentProgress(0)
    setNeedsTap(false)
    if (nextIndex === index) {
      const video = videoRef.current
      if (video) {
        video.currentTime = startSec
        void video.play().catch(() => setNeedsTap(true))
      }
      return
    }
    setIndex(Math.max(0, Math.min(segments.length - 1, nextIndex)))
  }

  const advance = () => {
    if (advancedForRef.current === index) return
    advancedForRef.current = index
    if (index >= segments.length - 1) {
      onClose()
      return
    }
    setSegmentProgress(0)
    setIndex(index + 1)
  }

  const startPlayback = (video: HTMLVideoElement) => {
    video.currentTime = startSec
    void video
      .play()
      .then(() => setNeedsTap(false))
      .catch(() => setNeedsTap(true))
  }

  return (
    <div className="playback-overlay" role="dialog" aria-label="Project preview">
      <div className="playback-progress" aria-hidden="true">
        {segments.map((seg, i) => (
          <span
            key={`${seg.clip.id}:${i}`}
            style={{ flexGrow: Math.max(1, seg.endMs - seg.startMs) }}
          >
            <i
              style={{
                width:
                  i < index ? '100%' : i === index ? `${Math.round(segmentProgress * 100)}%` : '0%',
              }}
            />
          </span>
        ))}
      </div>

      <video
        ref={bindVideo}
        className="playback-video"
        playsInline
        preload="auto"
        onLoadedMetadata={(event) => {
          loadedIndexRef.current = index
          startPlayback(event.currentTarget)
        }}
        onEnded={() => {
          if (loadedIndexRef.current !== index) return
          advance()
        }}
        onTimeUpdate={(event) => {
          if (loadedIndexRef.current !== index) return
          const video = event.currentTarget
          const elapsed = video.currentTime - startSec
          setSegmentProgress(segmentMs > 0 ? Math.min(1, (elapsed * 1000) / segmentMs) : 0)
          if (video.currentTime >= endSec - 0.03) {
            video.pause()
            advance()
          }
        }}
      />

      <div className="playback-tap-zones">
        <button
          type="button"
          aria-label="Previous clip"
          onClick={() => goTo(index - 1)}
          disabled={index === 0}
        />
        <button type="button" aria-label="Stop preview" onClick={onClose} />
        <button type="button" aria-label="Next clip" onClick={() => goTo(index + 1)} />
      </div>

      {needsTap ? (
        <button
          type="button"
          className="playback-resume"
          onClick={() => {
            const video = videoRef.current
            if (video) void video.play().then(() => setNeedsTap(false)).catch(() => undefined)
          }}
        >
          ▶ Tap to play
        </button>
      ) : null}

      <div className="playback-caption">
        Clip {index + 1} / {segments.length} · tap edges to skip · tap middle to stop
      </div>
    </div>
  )
}
