import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import {
  MAX_IMAGE_DURATION_MS,
  MIN_IMAGE_DURATION_MS,
  clampImageDurationMs,
  formatDuration,
  type ClipRecord,
} from '../lib/types'
import { TimelineThumbImage } from './timeline-thumb-image'

/** Steppers move in half-second increments — coarse enough to feel, fine
 * enough to land an exact value after a rough drag. */
const STEP_MS = 500
/** One-tap durations covering the common "how long should this show" answers. */
const PRESETS_MS = [1000, 2000, 3000, 5000, 10_000]

interface ImageDurationStripProps {
  clip: ClipRecord
  onDone: (durationMs: number) => Promise<void>
  onCancel: () => void
}

/**
 * The photo counterpart of TrimStrip. A still has no media length to trim
 * within — its duration is a free choice that can grow as well as shrink,
 * so instead of two handles over a fixed filmstrip this strip is a scale
 * from 0 to the maximum: drag the single handle to any length, tap a
 * preset, or nudge by half-seconds for an exact value. The readout always
 * shows the precise result.
 */
export function ImageDurationStrip(handle: Handle<ImageDurationStripProps>) {
  const { props } = handle
  let durationMs = clampImageDurationMs(props.clip.durationMs)
  let saving = false
  let error: string | null = null
  let dragging = false

  const setDuration = (nextMs: number) => {
    durationMs = clampImageDurationMs(nextMs)
    void handle.update()
  }

  const msFromClientX = (clientX: number, strip: HTMLElement) => {
    const rect = strip.getBoundingClientRect()
    if (rect.width <= 0) return durationMs
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return ratio * MAX_IMAGE_DURATION_MS
  }

  const startHandleDrag = (event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const dragHandle = event.currentTarget as HTMLButtonElement
    const strip = dragHandle.closest('.trim-strip-track') as HTMLElement | null
    if (!strip) return

    dragHandle.setPointerCapture(event.pointerId)
    dragging = true
    void handle.update()

    const onMove = (ev: PointerEvent) => {
      setDuration(msFromClientX(ev.clientX, strip))
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

  const onDoneClick = () => {
    void (async () => {
      saving = true
      error = null
      void handle.update()
      try {
        await props.onDone(clampImageDurationMs(durationMs))
      } catch (err) {
        error = err instanceof Error ? err.message : 'Could not save duration'
        saving = false
        void handle.update()
      }
    })()
  }

  return () => {
    const clip = props.clip
    const thumb = clip.thumbs?.find(Boolean) ?? clip.poster ?? null
    const pct = (durationMs / MAX_IMAGE_DURATION_MS) * 100

    return (
      <div className="trim-strip image-duration-strip" role="group" aria-label="Photo duration">
        <div className="trim-strip-meta">
          <span className="trim-kept-label">{formatDuration(durationMs)} on screen</span>
          {error ? <span className="trim-error">{error}</span> : null}
        </div>

        <div className="trim-strip-track">
          <div className="trim-strip-filmstrip" aria-hidden>
            {thumb ? (
              <TimelineThumbImage blob={thumb} className="trim-strip-frame" alt="" />
            ) : (
              <div className="clip-filmstrip-placeholder" />
            )}
          </div>

          <div className="trim-dim trim-dim-right" style={{ width: `${100 - pct}%` }} aria-hidden />
          <div className="trim-selection" style={{ left: '0%', width: `${pct}%` }} aria-hidden />

          <button
            type="button"
            className={`trim-handle trim-handle-right${dragging ? ' active' : ''}`}
            style={{ left: `${pct}%` }}
            aria-label="Photo duration handle"
            aria-valuetext={formatDuration(durationMs)}
            mix={on('pointerdown', (event) => startHandleDrag(event))}
          />
        </div>

        <div className="image-duration-controls">
          <div className="image-duration-steppers" role="group" aria-label="Adjust duration">
            <button
              type="button"
              className="btn btn-ghost image-duration-step"
              aria-label="Shorten by half a second"
              disabled={saving || durationMs <= MIN_IMAGE_DURATION_MS}
              mix={on('click', () => setDuration(durationMs - STEP_MS))}
            >
              −0.5s
            </button>
            <span className="image-duration-value" aria-live="polite">
              {formatDuration(durationMs)}
            </span>
            <button
              type="button"
              className="btn btn-ghost image-duration-step"
              aria-label="Lengthen by half a second"
              disabled={saving || durationMs >= MAX_IMAGE_DURATION_MS}
              mix={on('click', () => setDuration(durationMs + STEP_MS))}
            >
              +0.5s
            </button>
          </div>
          <div className="image-duration-presets" role="group" aria-label="Duration presets">
            {PRESETS_MS.map((presetMs) => (
              <button
                key={presetMs}
                type="button"
                className={`image-duration-preset${durationMs === presetMs ? ' active' : ''}`}
                disabled={saving}
                mix={on('click', () => setDuration(presetMs))}
              >
                {presetMs / 1000}s
              </button>
            ))}
          </div>
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
