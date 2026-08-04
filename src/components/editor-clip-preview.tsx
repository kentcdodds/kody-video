import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import { BlobVideo } from './blob-video'
import { IconPause, IconPlay } from './icons'
import type { ClipRecord } from '../lib/types'

export interface EditorClipPreviewHandle {
  seekToMs: (timeMs: number) => void
  pause: () => void
}

interface EditorClipPreviewProps {
  clip: ClipRecord
  apiRef?: { current: EditorClipPreviewHandle | null }
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
export function EditorClipPreview(handle: Handle<EditorClipPreviewProps>) {
  const { props } = handle
  let media: HTMLVideoElement | null = null
  let playing = false
  /** An explicit seek before loadeddata must not be snapped back to the trim
   * start when the metadata arrives. */
  let explicitSeek = false

  const setPlaying = (next: boolean) => {
    if (playing === next) return
    playing = next
    void handle.update()
  }

  // Bound to the element's mount/unmount (not the first media event) so the
  // imperative handle works immediately — early pause()/seekToMs() calls on a
  // still-loading clip must act instead of silently no-oping (#58).
  const bindVideo = (video: HTMLVideoElement, signal: AbortSignal) => {
    media = video
    explicitSeek = false
    const apiRef = props.apiRef
    if (!apiRef) return
    apiRef.current = {
      seekToMs: (timeMs: number) => {
        const el = media
        if (!el) return
        explicitSeek = true
        el.pause()
        setPlaying(false)
        const sec = Math.max(0, Math.min(timeMs, props.clip.durationMs)) / 1000
        if (Math.abs(el.currentTime - sec) > 0.02) {
          el.currentTime = sec
        } else {
          nudgeFrame(el)
        }
      },
      pause: () => {
        const el = media
        if (!el) return
        el.pause()
        setPlaying(false)
      },
    }
    signal.addEventListener('abort', () => {
      media = null
      apiRef.current = null
    })
  }

  const togglePlayback = () => {
    const video = media
    if (!video) return

    if (!video.paused) {
      video.pause()
      setPlaying(false)
      return
    }

    const startSec = props.clip.trimStartMs / 1000
    const endSec = props.clip.trimEndMs / 1000
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

  return () => {
    const clip = props.clip
    const startSec = clip.trimStartMs / 1000
    const endSec = clip.trimEndMs / 1000
    const remountKey = `${clip.id}:${clip.blob.size}:${clip.blob.type}:${clip.trimStartMs}:${clip.trimEndMs}`

    return (
      <div className="editor-clip-preview-wrap">
        <BlobVideo
          key={remountKey}
          blob={clip.blob}
          videoRef={bindVideo}
          className="editor-clip-preview"
          playsInline
          preload="auto"
          mix={[
            on('loadeddata', (event) => {
              const video = event.currentTarget as HTMLVideoElement
              // Don't clobber a seek the user already made while loading.
              if (explicitSeek) return
              if (Math.abs(video.currentTime - startSec) > 0.04) {
                video.currentTime = startSec
                return
              }
              nudgeFrame(video)
            }),
            on('seeked', (event) => {
              const video = event.currentTarget as HTMLVideoElement
              if (video.paused) nudgeFrame(video)
            }),
            on('timeupdate', (event) => {
              const video = event.currentTarget as HTMLVideoElement
              if (!video.paused && video.currentTime >= endSec - 0.02) {
                video.pause()
                video.currentTime = endSec
                setPlaying(false)
              }
            }),
            on('pause', () => setPlaying(false)),
            on('play', () => setPlaying(true)),
            on('click', togglePlayback),
          ]}
        />
        <button
          type="button"
          className="editor-preview-affordance"
          aria-label={playing ? 'Pause clip preview' : 'Play clip preview'}
          mix={on('click', togglePlayback)}
        >
          {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
        </button>
      </div>
    )
  }
}
