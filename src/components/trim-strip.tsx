import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { formatDuration, type ClipRecord } from '../lib/types'
import { TimelineThumbImage } from './timeline-thumb-image'

const MIN_GAP_MS = 100

interface TrimStripProps {
  clip: ClipRecord
  onSeek: (timeMs: number) => void
  onDone: (trimStartMs: number, trimEndMs: number) => Promise<void>
  onCancel: () => void
}

export function TrimStrip({ clip, onSeek, onDone, onCancel }: TrimStripProps) {
  const [startMs, setStartMs] = useState(clip.trimStartMs)
  const [endMs, setEndMs] = useState(clip.trimEndMs)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeHandle, setActiveHandle] = useState<'start' | 'end' | null>(null)
  const rangeRef = useRef({ startMs: clip.trimStartMs, endMs: clip.trimEndMs })

  const duration = Math.max(1, clip.durationMs)
  const keptMs = Math.max(0, endMs - startMs)
  const thumbs = clip.thumbs?.filter(Boolean) ?? []
  const startPct = (startMs / duration) * 100
  const endPct = (endMs / duration) * 100

  const msFromClientX = (clientX: number, strip: HTMLElement) => {
    const rect = strip.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return Math.round(ratio * duration)
  }

  const bindHandle = (which: 'start' | 'end') => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget
    const strip = handle.closest('.trim-strip-track') as HTMLElement | null
    if (!strip) return

    handle.setPointerCapture(event.pointerId)
    setActiveHandle(which)

    const onMove = (ev: PointerEvent) => {
      const next = msFromClientX(ev.clientX, strip)
      const { startMs: curStart, endMs: curEnd } = rangeRef.current
      if (which === 'start') {
        const clamped = Math.max(0, Math.min(next, curEnd - MIN_GAP_MS))
        rangeRef.current = { startMs: clamped, endMs: curEnd }
        setStartMs(clamped)
        onSeek(clamped)
      } else {
        const clamped = Math.min(duration, Math.max(next, curStart + MIN_GAP_MS))
        rangeRef.current = { startMs: curStart, endMs: clamped }
        setEndMs(clamped)
        onSeek(clamped)
      }
    }

    const onUp = (ev: PointerEvent) => {
      try {
        handle.releasePointerCapture(ev.pointerId)
      } catch {
        /* already released */
      }
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      setActiveHandle(null)
    }

    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)

    onSeek(which === 'start' ? rangeRef.current.startMs : rangeRef.current.endMs)
  }

  return (
    <div className="trim-strip" role="group" aria-label="Trim clip">
      <div className="trim-strip-meta">
        <span className="trim-kept-label">{formatDuration(keptMs)} kept</span>
        {error ? <span className="trim-error">{error}</span> : null}
      </div>

      <div className="trim-strip-track">
        <div className="trim-strip-filmstrip" aria-hidden>
          {thumbs.length > 0 ? (
            thumbs.map((thumb, index) => (
              <TimelineThumbImage
                key={`${clip.id}-trim-thumb-${index}`}
                blob={thumb}
                className="trim-strip-frame"
                alt=""
              />
            ))
          ) : (
            <div className="clip-filmstrip-placeholder" />
          )}
        </div>

        <div className="trim-dim trim-dim-left" style={{ width: `${startPct}%` }} aria-hidden />
        <div
          className="trim-dim trim-dim-right"
          style={{ width: `${100 - endPct}%` }}
          aria-hidden
        />

        <div
          className="trim-selection"
          style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
          aria-hidden
        />

        <button
          type="button"
          className={`trim-handle trim-handle-left${activeHandle === 'start' ? ' active' : ''}`}
          style={{ left: `${startPct}%` }}
          aria-label="Trim start"
          onPointerDown={bindHandle('start')}
        />
        <button
          type="button"
          className={`trim-handle trim-handle-right${activeHandle === 'end' ? ' active' : ''}`}
          style={{ left: `${endPct}%` }}
          aria-label="Trim end"
          onPointerDown={bindHandle('end')}
        />
      </div>

      <div className="trim-strip-actions">
        <button type="button" className="btn btn-ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving}
          onClick={() => {
            void (async () => {
              const { startMs: s, endMs: e } = rangeRef.current
              if (!(e > s)) {
                setError('End must be after start.')
                return
              }
              setSaving(true)
              setError(null)
              try {
                await onDone(Math.round(s), Math.round(e))
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Could not save trim')
                setSaving(false)
              }
            })()
          }}
        >
          {saving ? 'Saving…' : 'Done'}
        </button>
      </div>
    </div>
  )
}
