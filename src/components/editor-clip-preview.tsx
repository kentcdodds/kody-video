import { BlobVideo } from './blob-video'
import type { ClipRecord } from '../lib/types'

interface EditorClipPreviewProps {
  clip: ClipRecord
}

/**
 * Stage preview for the selected timeline clip.
 * Remounts whenever the clip identity, blob, or trim start changes so the
 * object URL and seek target cannot stick on a previous selection.
 */
export function EditorClipPreview({ clip }: EditorClipPreviewProps) {
  const startSec = clip.trimStartMs / 1000
  const remountKey = `${clip.id}:${clip.blob.size}:${clip.blob.type}:${clip.trimStartMs}`

  return (
    <BlobVideo
      key={remountKey}
      blob={clip.blob}
      className="editor-clip-preview"
      muted
      playsInline
      preload="auto"
      onLoadedData={(event) => {
        const video = event.currentTarget
        if (Math.abs(video.currentTime - startSec) > 0.04) {
          video.currentTime = startSec
        }
      }}
      onSeeked={(event) => {
        // Nudge a frame decode after seek so WebM previews aren't stuck blank.
        const video = event.currentTarget
        if (video.paused && video.readyState >= 2) {
          void video.play().then(() => {
            video.pause()
          }).catch(() => undefined)
        }
      }}
    />
  )
}
