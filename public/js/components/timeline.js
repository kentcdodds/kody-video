/**
 * Filmstrip timeline: tiles sized by duration, tap to select, press-and-hold
 * to lift and reorder, swipe to scroll (with a release fling). Tiles are
 * DOM-persistent during a drag — the strip never rebuilds mid-gesture, so
 * pointer capture survives.
 */

import { define, h, KvElement } from '../dom.js'
import { reorderClips } from '../lib/storage.js'
import { effectiveDurationMs, formatDuration } from '../lib/types.js'

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

export function tileWidthForClip(clip) {
  const seconds = effectiveDurationMs(clip) / 1000
  return Math.round(Math.min(MAX_TILE_WIDTH, Math.max(MIN_TILE_WIDTH, seconds * PX_PER_SECOND)))
}

export class KvTimeline extends KvElement {
  #track = null
  #tiles = new Map()
  #signature = null
  #drag = null
  #flingRaf = 0
  #dropIndicator = h('div', { className: 'timeline-drop-indicator' })
  #positioned = false

  /** A reconnect revoked the previous mount's blob URLs — rebuild fresh. */
  mounted() {
    this.#track = null
    this.#tiles.clear()
    this.#signature = null
    this.#positioned = false
    this.#drag = null
  }

  render() {
    // The editor attaches the element before assigning props on the first
    // sync — nothing to draw yet.
    if (!this.props) return
    const { clips, selectedClipId } = this.props

    if (clips.length === 0) {
      this.#track = null
      this.#tiles.clear()
      this.#signature = null
      this.#positioned = false
      this.replaceChildren(
        h(
          'div',
          { className: 'timeline', 'aria-label': 'Timeline empty' },
          h('p', { className: 'timeline-empty muted' }, 'Hold the preview to add clips'),
        ),
      )
      return
    }

    if (!this.#track) {
      this.#track = h('div', {
        className: 'timeline',
        role: 'listbox',
        'aria-label': 'Clip timeline',
        // Android long-press opens a context menu and cancels the pointer
        // stream, which would kill the lift right as it begins.
        oncontextmenu: (event) => event.preventDefault(),
      })
      this.replaceChildren(this.#track)
      this.#positioned = false
    }

    // Rebuild tiles only when the clip data actually changed; selection-only
    // updates just retag classes (keeps scroll position and DOM identity).
    const signature = clips
      .map((clip) => `${clip.id}:${clip.trimStartMs}:${clip.trimEndMs}:${clip.thumbs?.length ?? 0}`)
      .join('|')
    if (signature !== this.#signature) {
      this.#signature = signature
      this.#clearDrag()
      this.#buildTiles(clips)
    }
    this.#syncSelection(selectedClipId)

    if (!this.#positioned) {
      this.#positioned = true
      // Open positioned at the selected clip (the most recent one by
      // default) — editing usually means checking the last thing recorded.
      queueMicrotask(() => {
        const track = this.#track
        const target = selectedClipId ? this.#tiles.get(selectedClipId) : null
        if (!track || !target) return
        const delta = target.getBoundingClientRect().right - track.getBoundingClientRect().right
        track.scrollLeft = Math.max(0, delta + 12)
      })
    }
  }

  #buildTiles(clips) {
    const track = this.#track
    this.#tiles.clear()
    const slots = clips.map((clip, index) => {
      const thumbs = clip.thumbs?.filter(Boolean) ?? []
      const tile = h(
        'button',
        {
          type: 'button',
          className: 'clip-thumb',
          role: 'option',
          'aria-label': `Clip ${index + 1}, ${formatDuration(effectiveDurationMs(clip))}`,
          style: { width: `${tileWidthForClip(clip)}px` },
          dataset: { clipId: clip.id },
          onpointerdown: (event) => this.#onPointerDown(event, clip, index),
          onpointermove: (event) => this.#onPointerMove(event),
          onpointerup: (event) => this.#finishPointer(event, false),
          onpointercancel: (event) => this.#finishPointer(event, true),
          onclick: (event) => event.preventDefault(),
        },
        h(
          'div',
          { className: 'clip-filmstrip' },
          thumbs.length > 0
            ? thumbs.map((thumb) =>
                h('img', {
                  className: 'clip-filmstrip-frame',
                  src: this.blobUrl(thumb),
                  alt: '',
                  draggable: false,
                }),
              )
            : h('div', { className: 'clip-filmstrip-placeholder', 'aria-hidden': 'true' }),
        ),
        h('span', { className: 'clip-dur' }, formatDuration(effectiveDurationMs(clip))),
      )
      this.#tiles.set(clip.id, tile)
      return h('div', { className: 'timeline-slot' }, tile)
    })
    track.replaceChildren(...slots)
  }

  #syncSelection(selectedClipId) {
    for (const [id, tile] of this.#tiles) {
      const selected = id === selectedClipId
      tile.classList.toggle('selected', selected)
      tile.setAttribute('aria-selected', String(selected))
    }
  }

  #selectClip(id) {
    this.props.onSelect(id)
    this.#tiles.get(id)?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
  }

  #stopFling() {
    cancelAnimationFrame(this.#flingRaf)
    this.#flingRaf = 0
  }

  /** Continue a released swipe with decaying momentum. */
  #startFling(samples) {
    const track = this.#track
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
    const tick = (now) => {
      const elapsed = Math.min(64, now - previous)
      previous = now
      track.scrollLeft += velocity * elapsed
      velocity *= FLING_DECAY ** (elapsed / 16)
      this.#flingRaf = Math.abs(velocity) >= FLING_MIN_VELOCITY ? requestAnimationFrame(tick) : 0
    }
    this.#flingRaf = requestAnimationFrame(tick)
  }

  #clearDrag() {
    if (this.#drag?.longPressTimer) clearTimeout(this.#drag.longPressTimer)
    this.#drag = null
    this.#dropIndicator.remove()
    this.#track?.classList.remove('is-dragging')
    for (const tile of this.#tiles.values()) tile.classList.remove('lifting')
  }

  /** Gap index in 0..clips.length (before tile i, or after the last tile). */
  #gapFromX(clientX) {
    const tiles = Array.from(this.#track?.querySelectorAll('[data-clip-id]') ?? [])
    for (let i = 0; i < tiles.length; i += 1) {
      const rect = tiles[i].getBoundingClientRect()
      if (clientX < rect.left + rect.width / 2) return i
    }
    return tiles.length
  }

  #placeIndicator(gap) {
    const track = this.#track
    if (!track) return
    const slots = track.querySelectorAll('.timeline-slot')
    this.#dropIndicator.classList.toggle('timeline-drop-trailing', gap >= slots.length)
    if (gap >= slots.length) {
      track.append(this.#dropIndicator)
    } else {
      slots[gap].prepend(this.#dropIndicator)
    }
  }

  #beginLift(clipId) {
    const drag = this.#drag
    if (!drag || drag.clipId !== clipId || drag.lifted || drag.scrolling) return
    drag.lifted = true
    drag.gapIndex = drag.fromIndex
    this.#tiles.get(clipId)?.classList.add('lifting')
    this.#track?.classList.add('is-dragging')
    this.#placeIndicator(drag.fromIndex)
    navigator.vibrate?.(20)
  }

  #onPointerDown(event, clip, index) {
    if (event.button !== 0) return
    this.#stopFling()
    // A previous session that never reached finishPointer (e.g. its tile
    // unmounted mid-drag) must not leak into this gesture.
    if (this.#drag) this.#clearDrag()
    event.currentTarget.setPointerCapture(event.pointerId)

    this.#drag = {
      clipId: clip.id,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: this.#track?.scrollLeft ?? 0,
      fromIndex: index,
      pointerId: event.pointerId,
      longPressTimer: setTimeout(() => this.#beginLift(clip.id), LONG_PRESS_MS),
      lifted: false,
      scrolling: false,
      gapIndex: index,
      samples: [{ t: performance.now(), x: event.clientX }],
    }
  }

  /** Keep a lifted clip draggable to offscreen targets. */
  #edgeAutoScroll(clientX) {
    const track = this.#track
    if (!track) return
    const rect = track.getBoundingClientRect()
    if (clientX < rect.left + EDGE_SCROLL_ZONE_PX) {
      track.scrollLeft -= EDGE_SCROLL_STEP_PX
    } else if (clientX > rect.right - EDGE_SCROLL_ZONE_PX) {
      track.scrollLeft += EDGE_SCROLL_STEP_PX
    }
  }

  #onPointerMove(event) {
    const state = this.#drag
    if (!state || state.pointerId !== event.pointerId) return

    if (state.lifted) {
      const nextGap = this.#gapFromX(event.clientX)
      if (state.gapIndex !== nextGap) {
        state.gapIndex = nextGap
        this.#placeIndicator(nextGap)
      }
      this.#edgeAutoScroll(event.clientX)
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
    // pan proved flaky on real Android devices.
    if (this.#track) this.#track.scrollLeft = state.startScrollLeft - dx
    state.samples.push({ t: performance.now(), x: event.clientX })
    if (state.samples.length > 6) state.samples.shift()
  }

  #finishPointer(event, cancelled) {
    const state = this.#drag
    if (!state || state.pointerId !== event.pointerId) return

    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* already released */
    }

    const { clipId, fromIndex, lifted, scrolling, gapIndex: gap, samples } = state
    this.#clearDrag()

    if (scrolling) {
      if (!cancelled) this.#startFling(samples)
      return
    }
    if (cancelled) return
    if (!lifted) {
      this.#selectClip(clipId)
      return
    }

    const nextIds = this.props.clips.map((c) => c.id)
    const [removed] = nextIds.splice(fromIndex, 1)
    let insertAt = gap
    if (gap > fromIndex) insertAt = gap - 1
    if (insertAt === fromIndex) {
      this.#selectClip(clipId)
      return
    }
    nextIds.splice(insertAt, 0, removed)
    this.#selectClip(clipId)
    void reorderClips(this.props.projectId, nextIds).then(() => this.props.refresh())
  }
}
define('kv-timeline', KvTimeline)
