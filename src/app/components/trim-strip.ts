/**
 * In-timeline trim: filmstrip with draggable start/end handles. Handle drags
 * update styles imperatively (no re-render per pointer move).
 */

import { define, h, KvElement } from '../dom.ts'
import { formatDuration, type ClipRecord } from '../lib/types.ts'

const MIN_GAP_MS = 100

export interface TrimStripProps {
  clip: ClipRecord
  onSeek: (timeMs: number) => void
  onCancel: () => void
  onDone: (trimStartMs: number, trimEndMs: number) => Promise<void>
}

export class KvTrimStrip extends KvElement<TrimStripProps> {
  #startMs = 0
  #endMs = 0

  override render(): void {
    const { clip, onSeek, onCancel, onDone } = this.props
    this.#startMs = clip.trimStartMs
    this.#endMs = clip.trimEndMs
    const duration = () => Math.max(1, clip.durationMs)
    const thumbs = clip.thumbs?.filter(Boolean) ?? []

    const keptLabel = h('span', { className: 'trim-kept-label' })
    const errorLabel = h('span', { className: 'trim-error', hidden: true })
    const dimLeft = h('div', { className: 'trim-dim trim-dim-left', 'aria-hidden': 'true' })
    const dimRight = h('div', { className: 'trim-dim trim-dim-right', 'aria-hidden': 'true' })
    const selection = h('div', { className: 'trim-selection', 'aria-hidden': 'true' })
    const leftHandle = h('button', {
      type: 'button',
      className: 'trim-handle trim-handle-left',
      'aria-label': 'Trim start',
    })
    const rightHandle = h('button', {
      type: 'button',
      className: 'trim-handle trim-handle-right',
      'aria-label': 'Trim end',
    })
    const track = h(
      'div',
      { className: 'trim-strip-track' },
      h(
        'div',
        { className: 'trim-strip-filmstrip', 'aria-hidden': 'true' },
        thumbs.length > 0
          ? thumbs.map((thumb) =>
              h('img', {
                className: 'trim-strip-frame',
                src: this.blobUrl(thumb),
                alt: '',
                draggable: false,
              }),
            )
          : h('div', { className: 'clip-filmstrip-placeholder' }),
      ),
      dimLeft,
      dimRight,
      selection,
      leftHandle,
      rightHandle,
    )

    const sync = () => {
      const startPct = (this.#startMs / duration()) * 100
      const endPct = (this.#endMs / duration()) * 100
      keptLabel.textContent = `${formatDuration(Math.max(0, this.#endMs - this.#startMs))} kept`
      dimLeft.style.width = `${startPct}%`
      dimRight.style.width = `${100 - endPct}%`
      selection.style.left = `${startPct}%`
      selection.style.width = `${Math.max(0, endPct - startPct)}%`
      leftHandle.style.left = `${startPct}%`
      rightHandle.style.left = `${endPct}%`
    }

    const msFromClientX = (clientX: number): number => {
      const rect = track.getBoundingClientRect()
      if (rect.width <= 0) return 0
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      return Math.round(ratio * duration())
    }

    const startHandleDrag = (which: 'start' | 'end', event: PointerEvent): void => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const dragHandle = event.currentTarget as HTMLButtonElement
      dragHandle.setPointerCapture(event.pointerId)
      dragHandle.classList.add('active')

      const onMove = (ev: PointerEvent) => {
        const next = msFromClientX(ev.clientX)
        if (which === 'start') {
          this.#startMs = Math.max(0, Math.min(next, this.#endMs - MIN_GAP_MS))
          onSeek(this.#startMs)
        } else {
          this.#endMs = Math.min(duration(), Math.max(next, this.#startMs + MIN_GAP_MS))
          onSeek(this.#endMs)
        }
        sync()
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
        dragHandle.classList.remove('active')
      }
      dragHandle.addEventListener('pointermove', onMove)
      dragHandle.addEventListener('pointerup', onUp)
      dragHandle.addEventListener('pointercancel', onUp)

      onSeek(which === 'start' ? this.#startMs : this.#endMs)
    }

    leftHandle.addEventListener('pointerdown', (event) => startHandleDrag('start', event))
    rightHandle.addEventListener('pointerdown', (event) => startHandleDrag('end', event))

    const cancelButton = h(
      'button',
      { type: 'button', className: 'btn btn-ghost', onclick: () => onCancel() },
      'Cancel',
    )
    const doneButton = h(
      'button',
      {
        type: 'button',
        className: 'btn btn-primary',
        onclick: async () => {
          if (!(this.#endMs > this.#startMs)) {
            errorLabel.textContent = 'End must be after start.'
            errorLabel.hidden = false
            return
          }
          errorLabel.hidden = true
          cancelButton.disabled = true
          doneButton.disabled = true
          doneButton.textContent = 'Saving…'
          try {
            await onDone(Math.round(this.#startMs), Math.round(this.#endMs))
          } catch (err) {
            errorLabel.textContent = err instanceof Error ? err.message : 'Could not save trim'
            errorLabel.hidden = false
            if (this.isConnected) {
              cancelButton.disabled = false
              doneButton.disabled = false
              doneButton.textContent = 'Done'
            }
          }
        },
      },
      'Done',
    )

    this.replaceChildren(
      h(
        'div',
        { className: 'trim-strip', role: 'group', 'aria-label': 'Trim clip' },
        h('div', { className: 'trim-strip-meta' }, keptLabel, errorLabel),
        track,
        h('div', { className: 'trim-strip-actions' }, cancelButton, doneButton),
      ),
    )
    sync()
  }
}
define('kv-trim-strip', KvTrimStrip)
