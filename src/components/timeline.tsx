import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { reorderClips } from '../lib/storage'
import {
  effectiveDurationMs,
  formatDuration,
  type ClipId,
  type ClipRecord,
  type ProjectId,
} from '../lib/types'
import { TimelineThumbImage } from './timeline-thumb-image'

const PX_PER_SECOND = 26
const MIN_TILE_WIDTH = 56
const MAX_TILE_WIDTH = 200
/** Reorder only starts after a deliberate motionless press-and-hold — any
 * swipe must scroll the strip, never grab a clip. */
const LONG_PRESS_MS = 500
/** Movement beyond this before the long press cancels the pending lift. */
const MOVE_CANCEL_PX = 8
const EDGE_SCROLL_ZONE_PX = 44
const EDGE_SCROLL_STEP_PX = 12
/** Per-frame velocity decay for the release fling. */
const FLING_DECAY = 0.94
const FLING_MIN_VELOCITY = 0.06

interface TimelineProps {
  projectId: ProjectId
  clips: ClipRecord[]
  selectedClipId: ClipId | null
  onSelect: (id: ClipId) => void
  refresh: () => void
}

export function tileWidthForClip(clip: ClipRecord): number {
  const seconds = effectiveDurationMs(clip) / 1000
  return Math.round(Math.min(MAX_TILE_WIDTH, Math.max(MIN_TILE_WIDTH, seconds * PX_PER_SECOND)))
}

interface DragState {
  clipId: ClipId
  startX: number
  startY: number
  startScrollLeft: number
  fromIndex: number
  pointerId: number
  longPressTimer: ReturnType<typeof setTimeout> | null
  lifted: boolean
  /** Gesture turned into a drag-to-scroll (all pointer types). */
  scrolling: boolean
  gapIndex: number
  /** Recent pointer samples for the release fling. */
  samples: { t: number; x: number }[]
}

export function Timeline(handle: Handle<TimelineProps>) {
  const { props } = handle
  let draggingId: ClipId | null = null
  let gapIndex: number | null = null
  let trackEl: HTMLDivElement | null = null
  const tileRefs = new Map<ClipId, HTMLButtonElement>()
  let flingRaf = 0
  let drag: DragState | null = null

  const selectClip = (id: ClipId) => {
    props.onSelect(id)
    const el = tileRefs.get(id)
    el?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
  }

  /**
   * Open positioned at the selected clip (the most recent one by default) —
   * editing usually means checking or adjusting the last thing recorded, so
   * starting the strip at clip 1 constantly forced a scroll to the end.
   * Runs once per track mount; deferred a microtask so tile refs are set.
   */
  const bindTrack = (element: HTMLDivElement, signal: AbortSignal) => {
    trackEl = element
    signal.addEventListener('abort', () => {
      // The track detaches when the last clip is deleted (empty state) —
      // a later remount (undo) positions itself again via a fresh bind.
      if (trackEl === element) trackEl = null
    })
    queueMicrotask(() => {
      if (signal.aborted) return
      const selectedId = props.selectedClipId
      const target = selectedId ? tileRefs.get(selectedId) : null
      if (!target) return
      const delta = target.getBoundingClientRect().right - element.getBoundingClientRect().right
      // Align the selected clip toward the right edge (with a little padding)
      // so the tail of the project is in view; clamp handles short strips.
      element.scrollLeft = Math.max(0, delta + 12)
    })
  }

  const stopFling = () => {
    cancelAnimationFrame(flingRaf)
    flingRaf = 0
  }

  /** Continue a released swipe with decaying momentum. */
  const startFling = (samples: { t: number; x: number }[]) => {
    const track = trackEl
    if (!track || samples.length < 2) return
    const last = samples[samples.length - 1]
    const first = samples[0]
    // A finger that stopped moving before lifting should not fling.
    if (performance.now() - last.t > 80) return
    const dt = last.t - first.t
    if (dt <= 0) return
    // Finger velocity in px/ms; the strip scrolls opposite the finger.
    let velocity = -((last.x - first.x) / dt)
    if (Math.abs(velocity) < FLING_MIN_VELOCITY) return
    let previous = performance.now()
    const tick = (now: number) => {
      const elapsed = Math.min(64, now - previous)
      previous = now
      track.scrollLeft += velocity * elapsed
      velocity *= FLING_DECAY ** (elapsed / 16)
      if (Math.abs(velocity) >= FLING_MIN_VELOCITY) {
        flingRaf = requestAnimationFrame(tick)
      } else {
        flingRaf = 0
      }
    }
    flingRaf = requestAnimationFrame(tick)
  }

  const clearDrag = () => {
    if (drag?.longPressTimer) clearTimeout(drag.longPressTimer)
    drag = null
    draggingId = null
    gapIndex = null
    void handle.update()
  }

  /** Gap index in 0..clips.length (before tile i, or after the last tile). */
  const gapFromX = (clientX: number): number => {
    const track = trackEl
    if (!track) return 0
    const tiles = Array.from(track.querySelectorAll<HTMLElement>('[data-clip-id]'))
    for (let i = 0; i < tiles.length; i++) {
      const rect = tiles[i].getBoundingClientRect()
      if (clientX < rect.left + rect.width / 2) return i
    }
    return tiles.length
  }

  const beginLift = (clipId: ClipId) => {
    if (!drag || drag.clipId !== clipId || drag.lifted || drag.scrolling) return
    drag.lifted = true
    drag.gapIndex = drag.fromIndex
    draggingId = clipId
    gapIndex = drag.fromIndex
    void handle.update()
    navigator.vibrate?.(20)
  }

  const onPointerDown = (event: PointerEvent, clip: ClipRecord, index: number) => {
    if (event.button !== 0) return
    stopFling()
    // A previous session that never reached finishPointer (e.g. its tile
    // unmounted mid-drag) must not leak into this gesture.
    if (drag) clearDrag()
    ;(event.currentTarget as HTMLButtonElement).setPointerCapture(event.pointerId)

    drag = {
      clipId: clip.id,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: trackEl?.scrollLeft ?? 0,
      fromIndex: index,
      pointerId: event.pointerId,
      longPressTimer: setTimeout(() => beginLift(clip.id), LONG_PRESS_MS),
      lifted: false,
      scrolling: false,
      gapIndex: index,
      samples: [{ t: performance.now(), x: event.clientX }],
    }
  }

  /** Keep a lifted clip draggable to offscreen targets. */
  const edgeAutoScroll = (clientX: number) => {
    const track = trackEl
    if (!track) return
    const rect = track.getBoundingClientRect()
    if (clientX < rect.left + EDGE_SCROLL_ZONE_PX) {
      track.scrollLeft -= EDGE_SCROLL_STEP_PX
    } else if (clientX > rect.right - EDGE_SCROLL_ZONE_PX) {
      track.scrollLeft += EDGE_SCROLL_STEP_PX
    }
  }

  const onPointerMove = (event: PointerEvent) => {
    const state = drag
    if (!state || state.pointerId !== event.pointerId) return

    if (state.lifted) {
      const nextGap = gapFromX(event.clientX)
      state.gapIndex = nextGap
      // Only an actual gap change re-renders the strip (pointer moves fire
      // at sample rate; React's setState bail-out used to dedupe this).
      if (gapIndex !== nextGap) {
        gapIndex = nextGap
        void handle.update()
      }
      edgeAutoScroll(event.clientX)
      return
    }

    const dx = event.clientX - state.startX
    const dy = event.clientY - state.startY
    if (!state.scrolling && Math.hypot(dx, dy) < MOVE_CANCEL_PX) return

    // The finger moved before the long press fired: this is a scroll, not a
    // reorder — and no longer a tap either, so release must not select.
    if (state.longPressTimer) {
      clearTimeout(state.longPressTimer)
      state.longPressTimer = null
    }
    state.scrolling = true
    // Drive the scroll ourselves for every pointer type — relying on native
    // pan proved flaky on real Android devices, where the gesture could end
    // up neither scrolling nor cancelling.
    if (trackEl) trackEl.scrollLeft = state.startScrollLeft - dx
    state.samples.push({ t: performance.now(), x: event.clientX })
    if (state.samples.length > 6) state.samples.shift()
  }

  const finishPointer = (event: PointerEvent, cancelled: boolean) => {
    const state = drag
    if (!state || state.pointerId !== event.pointerId) return

    try {
      ;(event.currentTarget as HTMLButtonElement).releasePointerCapture(event.pointerId)
    } catch {
      /* already released */
    }

    const { clipId, fromIndex, lifted, scrolling, gapIndex: gap, samples } = state
    clearDrag()

    if (scrolling) {
      if (!cancelled) startFling(samples)
      return
    }
    if (cancelled) return
    if (!lifted) {
      selectClip(clipId)
      return
    }

    const nextIds = props.clips.map((c) => c.id)
    const [removed] = nextIds.splice(fromIndex, 1)
    let insertAt = gap
    if (gap > fromIndex) insertAt = gap - 1
    if (insertAt === fromIndex) {
      selectClip(clipId)
      return
    }
    nextIds.splice(insertAt, 0, removed)
    selectClip(clipId)
    void reorderClips(props.projectId, nextIds).then(() => props.refresh())
  }

  return () => {
    const { clips, selectedClipId } = props

    if (clips.length === 0) {
      return (
        <div key="timeline-empty" className="timeline" aria-label="Timeline empty">
          <p className="timeline-empty muted">Hold the preview to add clips</p>
        </div>
      )
    }

    return (
      <div
        key="timeline-track"
        className={`timeline${draggingId !== null ? ' is-dragging' : ''}`}
        role="listbox"
        aria-label="Clip timeline"
        mix={[
          ref((node, signal) => bindTrack(node as HTMLDivElement, signal)),
          on('contextmenu', (event) => {
            // Android long-press opens a context menu and cancels the pointer
            // stream, which would kill the lift right as it begins.
            event.preventDefault()
          }),
        ]}
      >
        {clips.map((clip, index) => {
          const selected = clip.id === selectedClipId
          const width = tileWidthForClip(clip)
          const thumbs = clip.thumbs?.filter(Boolean) ?? []
          const isDragging = draggingId === clip.id
          const showDropBefore = draggingId !== null && gapIndex === index

          return (
            <div key={clip.id} className="timeline-slot">
              {showDropBefore ? <div className="timeline-drop-indicator" aria-hidden /> : null}
              <button
                type="button"
                className={`clip-thumb${selected ? ' selected' : ''}${isDragging ? ' lifting' : ''}`}
                role="option"
                aria-selected={selected}
                aria-label={`Clip ${index + 1}, ${formatDuration(effectiveDurationMs(clip))}`}
                data-clip-id={clip.id}
                style={{ width: `${width}px` }}
                mix={[
                  ref((node, signal) => {
                    tileRefs.set(clip.id, node as HTMLButtonElement)
                    signal.addEventListener('abort', () => {
                      // A replaced tile's late abort must not clobber the
                      // entry its replacement just registered.
                      if (tileRefs.get(clip.id) !== node) return
                      tileRefs.delete(clip.id)
                      // A tile removed mid-drag ends its drag session.
                      if (drag?.clipId === clip.id) clearDrag()
                    })
                  }),
                  on('pointerdown', (e) => onPointerDown(e, clip, index)),
                  on('pointermove', (e) => onPointerMove(e)),
                  on('pointerup', (e) => finishPointer(e, false)),
                  on('pointercancel', (e) => finishPointer(e, true)),
                  on('click', (e) => {
                    e.preventDefault()
                  }),
                ]}
              >
                <div className="clip-filmstrip">
                  {thumbs.length > 0 ? (
                    thumbs.map((thumb, thumbIndex) => (
                      <TimelineThumbImage
                        key={`${clip.id}-thumb-${thumbIndex}`}
                        blob={thumb}
                        className="clip-filmstrip-frame"
                        alt=""
                      />
                    ))
                  ) : (
                    <div className="clip-filmstrip-placeholder" aria-hidden />
                  )}
                </div>
                <span className="clip-dur">{formatDuration(effectiveDurationMs(clip))}</span>
              </button>
            </div>
          )
        })}
        {draggingId !== null && gapIndex === clips.length ? (
          <div className="timeline-drop-indicator timeline-drop-trailing" aria-hidden />
        ) : null}
      </div>
    )
  }
}
