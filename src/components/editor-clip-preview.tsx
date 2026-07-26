import { useRef, useState, type MutableRefObject } from 'react'
import { BlobVideo } from './blob-video'
import type { ClipRecord } from '../lib/types'

export interface EditorClipPreviewHandle {
  seekToMs: (timeMs: number) => void
  pause: () => void
}

interface EditorClipPreviewProps {
  clip: ClipRecord
  apiRef?: MutableRefObject<EditorClipPreviewHandle | null>
}

function nudgeFrame(video: HTMLVideoElement): void {
  if (!video.paused || video.readyState < 2) return
  void video
    .play()
    .then(() => {
      video.pause()
    })
    .catch(() => undefined)
}

/**
 * Stage preview for the selected timeline clip.
 * Tap toggles playback within the trimmed range; expose seek for trim handles.
 */
export function EditorClipPreview({ clip, apiRef }: EditorClipPreviewProps) {
  const startSec = clip.trimStartMs / 1000
  const endSec = clip.trimEndMs / 1000
  const remountKey = `${clip.id}:${clip.blob.size}:${clip.blob.type}:${clip.trimStartMs}:${clip.trimEndMs}`
  const mediaRef = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)

  const bindVideo = (video: HTMLVideoElement | null) => {
    mediaRef.current = video
    if (!apiRef) return
    if (!video) {
      apiRef.current = null
      return
    }
    apiRef.current = {
      seekToMs: (timeMs: number) => {
        const el = mediaRef.current
        if (!el) return
        el.pause()
        setPlaying(false)
        const sec = Math.max(0, Math.min(timeMs, clip.durationMs)) / 1000
        if (Math.abs(el.currentTime - sec) > 0.02) {
          el.currentTime = sec
        } else {
          nudgeFrame(el)
        }
      },
      pause: () => {
        const el = mediaRef.current
        if (!el) return
        el.pause()
        setPlaying(false)
      },
    }
  }

  const togglePlayback = () => {
    const video = mediaRef.current
    if (!video) return

    if (!video.paused) {
      video.pause()
      setPlaying(false)
      return
    }

    const atEnd = video.currentTime >= endSec - 0.04
    const beforeStart = video.currentTime < startSec - 0.04
    if (atEnd || beforeStart) {
      video.currentTime = startSec
    }

    void video
      .play()
      .then(() => setPlaying(true))
      .catch(() => setPlaying(false))
  }

  return (
    <div className="editor-clip-preview-wrap">
      <BlobVideo
        key={remountKey}
        blob={clip.blob}
        className="editor-clip-preview"
        playsInline
        preload="auto"
        onLoadedData={(event) => {
          const video = event.currentTarget
          bindVideo(video)
          if (Math.abs(video.currentTime - startSec) > 0.04) {
            video.currentTime = startSec
            return
          }
          nudgeFrame(video)
        }}
        onSeeked={(event) => {
          bindVideo(event.currentTarget)
          if (event.currentTarget.paused) nudgeFrame(event.currentTarget)
        }}
        onTimeUpdate={(event) => {
          const video = event.currentTarget
          bindVideo(video)
          if (!video.paused && video.currentTime >= endSec - 0.02) {
            video.pause()
            video.currentTime = endSec
            setPlaying(false)
          }
        }}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        onClick={togglePlayback}
      />
      <button
        type="button"
        className="editor-preview-affordance"
        aria-label={playing ? 'Pause clip preview' : 'Play clip preview'}
        onClick={togglePlayback}
      >
        {playing ? (
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
            <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <path d="M8 5.5v13l11-6.5-11-6.5z" fill="currentColor" />
          </svg>
        )}
      </button>
    </div>
  )
}
