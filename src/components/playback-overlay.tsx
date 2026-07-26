import { useRef, useState } from 'react'
import { BlobVideo } from './blob-video'
import { effectiveDurationMs, type ClipRecord } from '../lib/types'

interface PlaybackOverlayProps {
  clips: ClipRecord[]
  onClose: () => void
}

/** Sequential preview driven by media element events (no useEffect). */
export function PlaybackOverlay({ clips, onClose }: PlaybackOverlayProps) {
  const [index, setIndex] = useState(0)
  const endSecRef = useRef(0)
  const advancingRef = useRef(false)
  const indexRef = useRef(index)
  const clip = clips[index]

  if (indexRef.current !== index) {
    indexRef.current = index
    advancingRef.current = false
  }

  if (!clip) {
    return null
  }

  const startSec = clip.trimStartMs / 1000
  endSecRef.current = Math.min(clip.trimEndMs, clip.durationMs) / 1000

  const advance = () => {
    if (advancingRef.current) return
    advancingRef.current = true
    if (index < clips.length - 1) {
      setIndex((current) => current + 1)
      return
    }
    onClose()
  }

  return (
    <div className="permission-panel" style={{ background: 'rgba(0,0,0,0.92)' }}>
      <div style={{ width: '100%', maxWidth: 360 }}>
        <BlobVideo
          key={`${clip.id}:${index}:${clip.blob.size}`}
          blob={clip.blob}
          className="camera-video"
          style={{ height: '55vh', borderRadius: 18, background: '#000' }}
          playsInline
          controls={false}
          preload="auto"
          onLoadedData={(event) => {
            event.currentTarget.currentTime = startSec
          }}
          onSeeked={(event) => {
            void event.currentTarget.play().catch(() => undefined)
          }}
          onEnded={advance}
          onTimeUpdate={(event) => {
            const video = event.currentTarget
            if (video.currentTime < endSecRef.current - 0.03) return
            video.pause()
            advance()
          }}
        />
        <p className="muted" style={{ margin: '12px 0 16px' }}>
          Playing clip {index + 1} / {clips.length} ·{' '}
          {Math.round(effectiveDurationMs(clip) / 100) / 10}s
        </p>
        <button type="button" className="btn btn-secondary" onClick={onClose} style={{ width: '100%' }}>
          Close preview
        </button>
      </div>
    </div>
  )
}
