/**
 * Sequential project preview, OK Video style: one persistent video element
 * (so unmuted playback stays allowed across clips), tap the left/right edges
 * for previous/next clip, tap the middle to stop.
 */

import { define, h, KvElement } from '../dom.ts'
import { planExport, type PlannedSegment } from '../lib/export/index.ts'
import { isInteractiveTarget } from '../lib/keyboard.ts'
import type { ClipRecord } from '../lib/types.ts'
import { iconPlay } from './icons.ts'

export interface PlaybackOverlayProps {
  clips: ClipRecord[]
  onClose: () => void
}

export class KvPlaybackOverlay extends KvElement<PlaybackOverlayProps> {
  #segments: PlannedSegment[] = []
  #index = 0
  #videoEl: HTMLVideoElement | null = null
  #progressFills: HTMLElement[] = []
  #caption: HTMLDivElement | null = null
  #resumeButton: HTMLButtonElement | null = null
  #urlState: { url: string | null; blob: Blob | null } = { url: null, blob: null }
  #advancedFor = -1
  /** Index whose media has actually loaded — gates stale timeupdate/ended
   * events from the previous clip that fire before the new source is ready. */
  #loadedIndex = -1

  #segment(): PlannedSegment | null {
    return this.#segments[this.#index] ?? null
  }
  #startSec(): number {
    const segment = this.#segment()
    return segment ? segment.startMs / 1000 : 0
  }
  #endSec(): number {
    const segment = this.#segment()
    return segment ? segment.endMs / 1000 : 0
  }
  #segmentMs(): number {
    const segment = this.#segment()
    return segment ? segment.endMs - segment.startMs : 0
  }

  /** Bind the current segment's blob to the persistent video element.
   * Returns whether a new source was assigned (i.e. `loadedmetadata` will
   * fire and drive playback). */
  #syncVideoSrc(): boolean {
    const el = this.#videoEl
    const segment = this.#segment()
    if (!el || !segment) return false
    if (this.#urlState.blob !== segment.clip.blob) {
      if (this.#urlState.url) URL.revokeObjectURL(this.#urlState.url)
      this.#urlState.url = URL.createObjectURL(segment.clip.blob)
      this.#urlState.blob = segment.clip.blob
      el.src = this.#urlState.url
      return true
    }
    return false
  }

  #syncProgress(segmentProgress: number): void {
    this.#progressFills.forEach((fill, i) => {
      fill.style.width =
        i < this.#index
          ? '100%'
          : i === this.#index
            ? `${Math.round(segmentProgress * 100)}%`
            : '0%'
    })
    if (this.#caption) {
      this.#caption.textContent = `Clip ${this.#index + 1} / ${this.#segments.length} · tap edges to skip · tap middle to stop`
    }
  }

  #setNeedsTap(needsTap: boolean): void {
    if (this.#resumeButton) this.#resumeButton.hidden = !needsTap
  }

  #startPlayback(video: HTMLVideoElement): void {
    video.currentTime = this.#startSec()
    void video
      .play()
      .then(() => this.#setNeedsTap(false))
      .catch(() => this.#setNeedsTap(true))
  }

  #enterSegment(): void {
    this.#advancedFor = -1
    this.#syncProgress(0)
    this.#setNeedsTap(false)
    // Same blob as the previous segment = no new source, so `loadedmetadata`
    // never re-fires (adjacent duplicated clips) — start directly.
    if (!this.#syncVideoSrc() && this.#videoEl && this.#videoEl.readyState >= 1) {
      this.#loadedIndex = this.#index
      this.#startPlayback(this.#videoEl)
    }
  }

  #goTo(nextIndex: number): void {
    if (nextIndex === this.#index) {
      this.#advancedFor = -1
      this.#setNeedsTap(false)
      this.#syncProgress(0)
      const video = this.#videoEl
      if (video) {
        video.currentTime = this.#startSec()
        void video.play().catch(() => this.#setNeedsTap(true))
      }
      return
    }
    this.#index = Math.max(0, Math.min(this.#segments.length - 1, nextIndex))
    this.#enterSegment()
  }

  #advance(): void {
    if (this.#advancedFor === this.#index) return
    this.#advancedFor = this.#index
    if (this.#index >= this.#segments.length - 1) {
      this.props.onClose()
      return
    }
    this.#index += 1
    this.#enterSegment()
  }

  override render(): void {
    const { clips, onClose } = this.props
    this.#segments = planExport(clips).segments

    // Desktop keyboard support: arrows skip clips, Space pauses, Esc closes.
    const onWindowKeyDown = (event: KeyboardEvent): void => {
      // Escape stays global; everything else yields to focused controls.
      if (event.code !== 'Escape' && isInteractiveTarget(event)) return
      switch (event.code) {
        case 'Escape':
          onClose()
          return
        case 'ArrowLeft':
          event.preventDefault()
          if (this.#index > 0) this.#goTo(this.#index - 1)
          return
        case 'ArrowRight':
          event.preventDefault()
          this.#goTo(this.#index + 1)
          return
        case 'Space': {
          event.preventDefault()
          // Auto-repeat while held must not rapid-toggle pause/resume.
          if (event.repeat) return
          const video = this.#videoEl
          if (!video) return
          if (video.paused) {
            void video
              .play()
              .then(() => this.#setNeedsTap(false))
              .catch(() => this.#setNeedsTap(true))
          } else {
            video.pause()
          }
          return
        }
        default:
          return
      }
    }
    window.addEventListener('keydown', onWindowKeyDown)
    this.signal.addEventListener('abort', () => {
      window.removeEventListener('keydown', onWindowKeyDown)
      if (this.#urlState.url) URL.revokeObjectURL(this.#urlState.url)
      this.#urlState = { url: null, blob: null }
      this.#videoEl = null
    })

    if (this.#segments.length === 0) {
      this.replaceChildren(
        h(
          'div',
          { className: 'playback-overlay', role: 'dialog', 'aria-label': 'Project preview' },
          h('p', { className: 'playback-empty' }, 'Nothing to play yet — record a clip first.'),
          h(
            'button',
            { type: 'button', className: 'btn btn-secondary', onclick: () => onClose() },
            'Close',
          ),
        ),
      )
      return
    }

    this.#progressFills = this.#segments.map(() => h('i', { style: { width: '0%' } }))
    const progress = h(
      'div',
      { className: 'playback-progress', 'aria-hidden': 'true' },
      this.#segments.map((seg, i) =>
        h(
          'span',
          { style: { flexGrow: String(Math.max(1, seg.endMs - seg.startMs)) } },
          this.#progressFills[i],
        ),
      ),
    )

    const video = h('video', {
      className: 'playback-video',
      playsInline: true,
      preload: 'auto',
      onloadedmetadata: () => {
        this.#loadedIndex = this.#index
        this.#startPlayback(video)
      },
      onended: () => {
        if (this.#loadedIndex !== this.#index) return
        this.#advance()
      },
      ontimeupdate: () => {
        if (this.#loadedIndex !== this.#index) return
        const elapsed = video.currentTime - this.#startSec()
        const ratio = this.#segmentMs() > 0 ? Math.min(1, (elapsed * 1000) / this.#segmentMs()) : 0
        this.#syncProgress(ratio)
        if (video.currentTime >= this.#endSec() - 0.03) {
          video.pause()
          this.#advance()
        }
      },
    })
    this.#videoEl = video

    this.#resumeButton = h(
      'button',
      {
        type: 'button',
        className: 'playback-resume',
        hidden: true,
        onclick: () => {
          void video
            .play()
            .then(() => this.#setNeedsTap(false))
            .catch(() => undefined)
        },
      },
      iconPlay(18),
      ' Tap to play',
    )

    this.#caption = h('div', { className: 'playback-caption' })

    this.replaceChildren(
      h(
        'div',
        { className: 'playback-overlay', role: 'dialog', 'aria-label': 'Project preview' },
        progress,
        video,
        h(
          'div',
          { className: 'playback-tap-zones' },
          h('button', {
            type: 'button',
            'aria-label': 'Previous clip',
            onclick: () => this.#goTo(this.#index - 1),
          }),
          h('button', { type: 'button', 'aria-label': 'Stop preview', onclick: () => onClose() }),
          h('button', {
            type: 'button',
            'aria-label': 'Next clip',
            onclick: () => this.#goTo(this.#index + 1),
          }),
        ),
        this.#resumeButton,
        this.#caption,
      ),
    )

    this.#index = 0
    this.#enterSegment()
  }
}
define('kv-playback-overlay', KvPlaybackOverlay)
