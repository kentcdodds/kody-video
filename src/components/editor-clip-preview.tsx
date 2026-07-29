import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import { BlobVideo } from './blob-video'
import { IconPause, IconPlay } from './icons'
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

  // Bound to the element's mount/unmount (not the first media event) so the
  // imperative handle works immediately — early pause()/seekToMs() calls on a
  // still-loading clip must act instead of silently no-oping (#58).
  const durationMsRef = useRef(clip.durationMs)
  durationMsRef.current = clip.durationMs
  const bindVideo = useCallback(
    (video: HTMLVideoElement | null) => {
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
          const sec = Math.max(0, Math.min(timeMs, durationMsRef.current)) / 1000
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
    },
    [apiRef],
  )

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
        videoRef={bindVideo}
        className="editor-clip-preview"
        playsInline
        preload="auto"
        onLoadedData={(event) => {
          const video = event.currentTarget
          if (Math.abs(video.currentTime - startSec) > 0.04) {
            video.currentTime = startSec
            return
          }
          nudgeFrame(video)
        }}
        onSeeked={(event) => {
          if (event.currentTarget.paused) nudgeFrame(event.currentTarget)
        }}
        onTimeUpdate={(event) => {
          const video = event.currentTarget
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
        {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
      </button>
    </div>
  )
}
