import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import { clampSplitMs, splitBounds } from '../lib/clip-edit'
import { formatDuration, type ClipRecord } from '../lib/types'
import { TimelineThumbImage } from './timeline-thumb-image'

const NUDGE_MS = 50

interface SplitStripProps {
  clip: ClipRecord
  initialSplitMs: number
  onSeek: (timeMs: number) => void
  onDone: (splitMs: number) => Promise<void>
  onCancel: () => void
}

export function SplitStrip(handle: Handle<SplitStripProps>) {
  const { props } = handle
  let splitMs = clampSplitMs(props.clip, props.initialSplitMs)
  let saving = false
  let error: string | null = null
  let dragging = false

  const duration = () => Math.max(1, props.clip.durationMs)

  const msFromClientX = (clientX: number, strip: HTMLElement) => {
    const rect = strip.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return Math.round(ratio * duration())
  }

  const applySplitMs = (next: number) => {
    if (saving) return
    splitMs = clampSplitMs(props.clip, next)
    props.onSeek(splitMs)
    void handle.update()
  }

  const startHandleDrag = (event: PointerEvent) => {
    if (event.button !== 0 || saving) return
    event.preventDefault()
    event.stopPropagation()
    const dragHandle = event.currentTarget as HTMLElement
    const strip = dragHandle.closest('.trim-strip-track') as HTMLElement | null
    if (!strip) return

    const originMs = splitMs
    const originX = event.clientX
    dragHandle.setPointerCapture(event.pointerId)
    dragging = true
    void handle.update()
    props.onSeek(splitMs)

    const onMove = (ev: PointerEvent) => {
      const width = strip.getBoundingClientRect().width
      if (width <= 0) return
      const deltaMs = Math.round(((ev.clientX - originX) / width) * duration())
      applySplitMs(originMs + deltaMs)
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
      dragging = false
      void handle.update()
    }

    dragHandle.addEventListener('pointermove', onMove)
    dragHandle.addEventListener('pointerup', onUp)
    dragHandle.addEventListener('pointercancel', onUp)
  }

  const startTrackScrub = (event: PointerEvent) => {
    if (event.button !== 0 || saving) return
    if ((event.target as HTMLElement | null)?.closest('.split-handle')) return
    event.preventDefault()
    const strip = event.currentTarget as HTMLElement
    strip.setPointerCapture(event.pointerId)
    dragging = true
    applySplitMs(msFromClientX(event.clientX, strip))

    const onMove = (ev: PointerEvent) => {
      applySplitMs(msFromClientX(ev.clientX, strip))
    }

    const onUp = (ev: PointerEvent) => {
      try {
        strip.releasePointerCapture(ev.pointerId)
      } catch {
        /* already released */
      }
      strip.removeEventListener('pointermove', onMove)
      strip.removeEventListener('pointerup', onUp)
      strip.removeEventListener('pointercancel', onUp)
      dragging = false
      void handle.update()
    }

    strip.addEventListener('pointermove', onMove)
    strip.addEventListener('pointerup', onUp)
    strip.addEventListener('pointercancel', onUp)
  }

  const onDoneClick = () => {
    void (async () => {
      saving = true
      error = null
      void handle.update()
      try {
        await props.onDone(Math.round(splitMs))
      } catch (err) {
        error = err instanceof Error ? err.message : 'Could not split clip'
        saving = false
        void handle.update()
      }
    })()
  }

  return () => {
    const clip = props.clip
    const bounds = splitBounds(clip)
    const thumbs = clip.thumbs?.filter(Boolean) ?? []
    const startPct = (bounds.start / duration()) * 100
    const endPct = (bounds.end / duration()) * 100
    const splitPct = (splitMs / duration()) * 100
    const leftMs = Math.max(0, splitMs - bounds.start)
    const rightMs = Math.max(0, bounds.end - splitMs)

    return (
      <div className="trim-strip split-strip" role="group" aria-label="Split clip">
        <div className="trim-strip-meta">
          <span className="trim-kept-label">
            Split at {formatDuration(splitMs)}
            <span className="split-halves-label">
              {' '}
              · {formatDuration(leftMs)} + {formatDuration(rightMs)}
            </span>
          </span>
          {error ? <span className="trim-error">{error}</span> : null}
        </div>

        <p className="split-strip-hint muted">
          Drag the line — or tap the filmstrip — to choose the cut.
        </p>

        <div
          className="trim-strip-track"
          mix={on('pointerdown', (event) => startTrackScrub(event))}
        >
          <div className="trim-strip-filmstrip" aria-hidden>
            {thumbs.length > 0 ? (
              thumbs.map((thumb, index) => (
                <TimelineThumbImage
                  key={`${clip.id}-split-thumb-${index}`}
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

          <div className="split-cut" style={{ left: `${splitPct}%` }} aria-hidden />

          <button
            type="button"
            className={`split-handle${dragging ? ' active' : ''}`}
            style={{ left: `${splitPct}%` }}
            disabled={saving}
            role="slider"
            aria-label="Split point"
            aria-valuemin={bounds.min}
            aria-valuemax={bounds.max}
            aria-valuenow={Math.round(splitMs)}
            aria-valuetext={formatDuration(splitMs)}
            mix={[
              on('pointerdown', (event) => startHandleDrag(event)),
              on('keydown', (event) => {
                if (saving) return
                if (event.key === 'ArrowLeft') {
                  event.preventDefault()
                  applySplitMs(splitMs - NUDGE_MS)
                } else if (event.key === 'ArrowRight') {
                  event.preventDefault()
                  applySplitMs(splitMs + NUDGE_MS)
                } else if (event.key === 'Home') {
                  event.preventDefault()
                  applySplitMs(bounds.min)
                } else if (event.key === 'End') {
                  event.preventDefault()
                  applySplitMs(bounds.max)
                }
              }),
            ]}
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
            {saving ? 'Splitting…' : 'Split'}
          </button>
        </div>
      </div>
    )
  }
}
