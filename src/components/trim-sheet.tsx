import { useState } from 'react'
import { formatDuration, type ClipRecord } from '../lib/types'

interface TrimSheetProps {
  clip: ClipRecord
  onClose: () => void
  onSave: (trimStartMs: number, trimEndMs: number) => Promise<void>
}

/** Remount with key={clip.id} when the selected clip changes. */
export function TrimSheet({ clip, onClose, onSave }: TrimSheetProps) {
  const [start, setStart] = useState(Math.round(clip.trimStartMs / 100) / 10)
  const [end, setEnd] = useState(Math.round(clip.trimEndMs / 100) / 10)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const maxSec = clip.durationMs / 1000

  return (
    <div className="sheet" role="dialog" aria-label="Trim clip">
      <h3>Trim clip</h3>
      <p className="muted" style={{ margin: 0 }}>
        Full length {formatDuration(clip.durationMs)}. Set in/out points in seconds.
      </p>
      <div className="trim-grid">
        <div className="field">
          <label htmlFor="trim-start">Start (s)</label>
          <input
            id="trim-start"
            type="number"
            min={0}
            max={maxSec}
            step={0.1}
            value={start}
            onChange={(e) => setStart(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="trim-end">End (s)</label>
          <input
            id="trim-end"
            type="number"
            min={0}
            max={maxSec}
            step={0.1}
            value={end}
            onChange={(e) => setEnd(Number(e.target.value))}
          />
        </div>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="sheet-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving}
          onClick={() => {
            void (async () => {
              const trimStartMs = Math.round(start * 1000)
              const trimEndMs = Math.round(end * 1000)
              if (!(trimEndMs > trimStartMs)) {
                setError('End must be after start.')
                return
              }
              setSaving(true)
              try {
                await onSave(trimStartMs, trimEndMs)
                onClose()
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Could not save trim')
              } finally {
                setSaving(false)
              }
            })()
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
