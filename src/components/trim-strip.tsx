import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import { formatDuration, type ClipRecord } from '../lib/types'
import { TimelineThumbImage } from './timeline-thumb-image'

const MIN_GAP_MS = 100

interface TrimStripProps {
  clip: ClipRecord
  onSeek: (timeMs: number) => void
  onDone: (trimStartMs: number, trimEndMs: number) => Promise<void>
  onCancel: () => void
}

export function TrimStrip(handle: Handle<TrimStripProps>) {
  const { props } = handle
  let startMs = props.clip.trimStartMs
  let endMs = props.clip.trimEndMs
  let saving = false
  let error: string | null = null
  let activeHandle: 'start' | 'end' | null = null

  const duration = () => Math.max(1, props.clip.durationMs)

  const msFromClientX = (clientX: number, strip: HTMLElement) => {
    const rect = strip.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return Math.round(ratio * duration())
  }

  const startHandleDrag = (which: 'start' | 'end', event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const dragHandle = event.currentTarget as HTMLButtonElement
    const strip = dragHandle.closest('.trim-strip-track') as HTMLElement | null
    if (!strip) return

    dragHandle.setPointerCapture(event.pointerId)
    activeHandle = which
    void handle.update()

    const onMove = (ev: PointerEvent) => {
      const next = msFromClientX(ev.clientX, strip)
      if (which === 'start') {
        startMs = Math.max(0, Math.min(next, endMs - MIN_GAP_MS))
        props.onSeek(startMs)
      } else {
        endMs = Math.min(duration(), Math.max(next, startMs + MIN_GAP_MS))
        props.onSeek(endMs)
      }
      void handle.update()
    }

    const onUp = (ev: PointerEvent) => {
      try {
        dragHandle.releasePointerCapture(ev.pointerId)
      } catch {
        /* already released */
      }
      dragHandle.removeEventListener('pointermove', onMove)
      dragHandle.removeEventListener('pointerup', onUp)
      dragHandle.removeEventListener('pointercancel', onUp)
      activeHandle = null
      void handle.update()
    }

    dragHandle.addEventListener('pointermove', onMove)
    dragHandle.addEventListener('pointerup', onUp)
    dragHandle.addEventListener('pointercancel', onUp)

    props.onSeek(which === 'start' ? startMs : endMs)
  }

  const onDoneClick = () => {
    void (async () => {
      if (!(endMs > startMs)) {
        error = 'End must be after start.'
        void handle.update()
        return
      }
      saving = true
      error = null
      void handle.update()
      try {
        await props.onDone(Math.round(startMs), Math.round(endMs))
      } catch (err) {
        error = err instanceof Error ? err.message : 'Could not save trim'
        saving = false
        void handle.update()
      }
    })()
  }

  return () => {
    const clip = props.clip
    const keptMs = Math.max(0, endMs - startMs)
    const thumbs = clip.thumbs?.filter(Boolean) ?? []
    const startPct = (startMs / duration()) * 100
    const endPct = (endMs / duration()) * 100

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
            mix={on('pointerdown', (event) => startHandleDrag('start', event))}
          />
          <button
            type="button"
            className={`trim-handle trim-handle-right${activeHandle === 'end' ? ' active' : ''}`}
            style={{ left: `${endPct}%` }}
            aria-label="Trim end"
            mix={on('pointerdown', (event) => startHandleDrag('end', event))}
          />
        </div>

        <div className="trim-strip-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={saving}
            mix={on('click', () => props.onCancel())}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            mix={on('click', onDoneClick)}
          >
            {saving ? 'Saving…' : 'Done'}
          </button>
        </div>
      </div>
    )
  }
}
