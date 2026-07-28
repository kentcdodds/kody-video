import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
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

export function Timeline({ projectId, clips, selectedClipId, onSelect, refresh }: TimelineProps) {
  const [draggingId, setDraggingId] = useState<ClipId | null>(null)
  const [gapIndex, setGapIndex] = useState<number | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const tileRefs = useRef(new Map<ClipId, HTMLButtonElement>())
  const flingRafRef = useRef(0)
  const dragRef = useRef<{
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
  } | null>(null)

  const selectClip = (id: ClipId) => {
    onSelect(id)
    const el = tileRefs.current.get(id)
    el?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
  }

  /**
   * Open positioned at the selected clip (the most recent one by default) —
   * editing usually means checking or adjusting the last thing recorded, so
   * starting the strip at clip 1 constantly forced a scroll to the end.
   * Runs once per mount; tile refs are already set (children bind first).
   */
  const initialScrollDoneRef = useRef(false)
  const selectedClipIdRef = useRef(selectedClipId)
  selectedClipIdRef.current = selectedClipId
  const bindTrack = useCallback((element: HTMLDivElement | null) => {
    trackRef.current = element
    if (!element || initialScrollDoneRef.current) return
    initialScrollDoneRef.current = true
    const selectedId = selectedClipIdRef.current
    const target = selectedId ? tileRefs.current.get(selectedId) : null
    if (!target) return
    const delta =
      target.getBoundingClientRect().right - element.getBoundingClientRect().right
    // Align the selected clip toward the right edge (with a little padding)
    // so the tail of the project is in view; clamp handles short strips.
    element.scrollLeft = Math.max(0, delta + 12)
  }, [])

  if (clips.length === 0) {
    return (
      <div className="timeline" aria-label="Timeline empty">
        <p className="timeline-empty muted">Hold the preview to add clips</p>
      </div>
    )
  }

  const stopFling = () => {
    cancelAnimationFrame(flingRafRef.current)
    flingRafRef.current = 0
  }

  /** Continue a released swipe with decaying momentum. */
  const startFling = (samples: { t: number; x: number }[]) => {
    const track = trackRef.current
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
        flingRafRef.current = requestAnimationFrame(tick)
      } else {
        flingRafRef.current = 0
      }
    }
    flingRafRef.current = requestAnimationFrame(tick)
  }

  const clearDrag = () => {
    const state = dragRef.current
    if (state?.longPressTimer) clearTimeout(state.longPressTimer)
    dragRef.current = null
    setDraggingId(null)
    setGapIndex(null)
  }

  /** Gap index in 0..clips.length (before tile i, or after the last tile). */
  const gapFromX = (clientX: number): number => {
    const track = trackRef.current
    if (!track) return 0
    const tiles = Array.from(track.querySelectorAll<HTMLElement>('[data-clip-id]'))
    for (let i = 0; i < tiles.length; i++) {
      const rect = tiles[i].getBoundingClientRect()
      if (clientX < rect.left + rect.width / 2) return i
    }
    return tiles.length
  }

  const beginLift = (clipId: ClipId) => {
    const state = dragRef.current
    if (!state || state.clipId !== clipId || state.lifted || state.scrolling) return
    state.lifted = true
    state.gapIndex = state.fromIndex
    setDraggingId(clipId)
    setGapIndex(state.fromIndex)
    navigator.vibrate?.(20)
  }

  const onPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    clip: ClipRecord,
    index: number,
  ) => {
    if (event.button !== 0) return
    stopFling()
    // A previous session that never reached finishPointer (e.g. its tile
    // unmounted mid-drag) must not leak into this gesture.
    if (dragRef.current) clearDrag()
    event.currentTarget.setPointerCapture(event.pointerId)

    dragRef.current = {
      clipId: clip.id,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: trackRef.current?.scrollLeft ?? 0,
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
    const track = trackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    if (clientX < rect.left + EDGE_SCROLL_ZONE_PX) {
      track.scrollLeft -= EDGE_SCROLL_STEP_PX
    } else if (clientX > rect.right - EDGE_SCROLL_ZONE_PX) {
      track.scrollLeft += EDGE_SCROLL_STEP_PX
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = dragRef.current
    if (!state || state.pointerId !== event.pointerId) return

    if (state.lifted) {
      const nextGap = gapFromX(event.clientX)
      state.gapIndex = nextGap
      setGapIndex(nextGap)
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
    const track = trackRef.current
    if (track) track.scrollLeft = state.startScrollLeft - dx
    state.samples.push({ t: performance.now(), x: event.clientX })
    if (state.samples.length > 6) state.samples.shift()
  }

  const finishPointer = (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const state = dragRef.current
    if (!state || state.pointerId !== event.pointerId) return

    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
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

    const nextIds = clips.map((c) => c.id)
    const [removed] = nextIds.splice(fromIndex, 1)
    let insertAt = gap
    if (gap > fromIndex) insertAt = gap - 1
    if (insertAt === fromIndex) {
      selectClip(clipId)
      return
    }
    nextIds.splice(insertAt, 0, removed)
    selectClip(clipId)
    void reorderClips(projectId, nextIds).then(refresh)
  }

  return (
    <div
      className={`timeline${draggingId !== null ? ' is-dragging' : ''}`}
      role="listbox"
      aria-label="Clip timeline"
      ref={bindTrack}
      onContextMenu={(event) => {
        // Android long-press opens a context menu and cancels the pointer
        // stream, which would kill the lift right as it begins.
        event.preventDefault()
      }}
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
              style={{ width }}
              onPointerDown={(e) => onPointerDown(e, clip, index)}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => finishPointer(e, false)}
              onPointerCancel={(e) => finishPointer(e, true)}
              onClick={(e) => {
                e.preventDefault()
              }}
              ref={(el) => {
                if (el) {
                  tileRefs.current.set(clip.id, el)
                } else {
                  tileRefs.current.delete(clip.id)
                  // Inline refs re-run on every render (null, then the new
                  // element), so defer: only treat this as an unmount — and
                  // end a drag session for a truly removed tile — if the
                  // tile did not immediately re-register in the same commit.
                  queueMicrotask(() => {
                    if (!tileRefs.current.has(clip.id) && dragRef.current?.clipId === clip.id) {
                      clearDrag()
                    }
                  })
                }
              }}
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
