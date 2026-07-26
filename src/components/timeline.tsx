import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
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
/** Reorder only starts after a deliberate press-and-hold — plain horizontal
 * swipes must scroll the strip, never grab a clip. */
const LONG_PRESS_MS = 400
/** Movement beyond this before the long press cancels the pending lift. */
const MOVE_CANCEL_PX = 8
const EDGE_SCROLL_ZONE_PX = 44
const EDGE_SCROLL_STEP_PX = 12

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
  const touchBlockerRef = useRef<((event: TouchEvent) => void) | null>(null)
  const dragRef = useRef<{
    clipId: ClipId
    startX: number
    startY: number
    startScrollLeft: number
    fromIndex: number
    pointerId: number
    pointerType: string
    longPressTimer: ReturnType<typeof setTimeout> | null
    lifted: boolean
    /** Mouse/pen gesture turned into a manual drag-to-scroll. */
    scrolling: boolean
    gapIndex: number
  } | null>(null)

  const selectClip = (id: ClipId) => {
    onSelect(id)
    const el = tileRefs.current.get(id)
    el?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
  }

  if (clips.length === 0) {
    return (
      <div className="timeline" aria-label="Timeline empty">
        <p className="timeline-empty muted">Hold the preview to add clips</p>
      </div>
    )
  }

  /** While a clip is lifted, stop native panning from hijacking the drag.
   * (React registers touch listeners as passive, so this must be native.) */
  const addPanBlocker = () => {
    const track = trackRef.current
    if (!track || touchBlockerRef.current) return
    const blocker = (event: TouchEvent) => event.preventDefault()
    touchBlockerRef.current = blocker
    track.addEventListener('touchmove', blocker, { passive: false })
  }

  const removePanBlocker = () => {
    const track = trackRef.current
    if (track && touchBlockerRef.current) {
      track.removeEventListener('touchmove', touchBlockerRef.current)
    }
    touchBlockerRef.current = null
  }

  const clearDrag = () => {
    const state = dragRef.current
    if (state?.longPressTimer) clearTimeout(state.longPressTimer)
    removePanBlocker()
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
    addPanBlocker()
    navigator.vibrate?.(20)
  }

  const onPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    clip: ClipRecord,
    index: number,
  ) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)

    dragRef.current = {
      clipId: clip.id,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: trackRef.current?.scrollLeft ?? 0,
      fromIndex: index,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      longPressTimer: setTimeout(() => beginLift(clip.id), LONG_PRESS_MS),
      lifted: false,
      scrolling: false,
      gapIndex: index,
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
    if (state.pointerType === 'touch') {
      // touch-action: pan-x lets the browser scroll the strip natively (with
      // momentum); it will send pointercancel when it takes over.
      return
    }
    // Mouse/pen have no native pan — scroll the strip manually.
    const track = trackRef.current
    if (track) track.scrollLeft = state.startScrollLeft - dx
  }

  const finishPointer = (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const state = dragRef.current
    if (!state || state.pointerId !== event.pointerId) return

    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* already released */
    }

    const { clipId, fromIndex, lifted, scrolling, gapIndex: gap } = state
    clearDrag()

    if (cancelled || scrolling) return
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
      ref={trackRef}
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
                if (el) tileRefs.current.set(clip.id, el)
                else tileRefs.current.delete(clip.id)
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
