import { useState } from 'react'
import { BlobVideo } from './blob-video'
import { effectiveDurationMs, formatDuration, type ClipId, type ClipRecord } from '../lib/types'

interface TimelineProps {
  clips: ClipRecord[]
  selectedClipId: ClipId | null
  onSelect: (id: ClipId) => void
}

export function Timeline({ clips, selectedClipId, onSelect }: TimelineProps) {
  if (clips.length === 0) {
    return (
      <div className="timeline" aria-label="Timeline empty">
        <p className="muted" style={{ margin: '18px 8px', fontSize: '0.9rem' }}>
          Hold the preview to add clips
        </p>
      </div>
    )
  }

  return (
    <div className="timeline" role="listbox" aria-label="Clip timeline">
      {clips.map((clip, index) => (
        <ClipThumb
          key={clip.id}
          clip={clip}
          index={index}
          selected={clip.id === selectedClipId}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

function ClipThumb({
  clip,
  index,
  selected,
  onSelect,
}: {
  clip: ClipRecord
  index: number
  selected: boolean
  onSelect: (id: ClipId) => void
}) {
  const [ready, setReady] = useState(false)

  return (
    <button
      type="button"
      className={`clip-thumb${selected ? ' selected' : ''}`}
      role="option"
      aria-selected={selected}
      aria-label={`Clip ${index + 1}, ${formatDuration(effectiveDurationMs(clip))}`}
      onClick={() => onSelect(clip.id)}
    >
      <BlobVideo
        blob={clip.blob}
        muted
        playsInline
        preload="metadata"
        onLoadedData={() => setReady(true)}
        style={{ opacity: ready ? 1 : 0.4 }}
      />
      <span className="clip-dur">{formatDuration(effectiveDurationMs(clip))}</span>
    </button>
  )
}
