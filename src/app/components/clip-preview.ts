/**
 * Stage preview for the selected timeline clip.
 * Tap toggles playback within the trimmed range; exposes seekToMs/pause for
 * the trim handles. The parent recreates this element when the clip (or its
 * trim) changes — like a keyed remount.
 */

import { define, h, KvElement } from '../dom.ts'
import type { ClipRecord } from '../lib/types.ts'
import { iconPause, iconPlay } from './icons.ts'

function nudgeFrame(video: HTMLVideoElement): void {
  if (!video.paused || video.readyState < 2) return
  void video
    .play()
    .then(() => {
      video.pause()
    })
    .catch(() => undefined)
}

export interface ClipPreviewProps {
  clip: ClipRecord
  /** While trimming the parent passes the untrimmed range so handle seeks
   * anywhere in the clip are visible. */
  trimOverride: boolean
}

export class KvClipPreview extends KvElement<ClipPreviewProps> {
  #video: HTMLVideoElement | null = null
  #affordance: HTMLButtonElement | null = null
  #playing = false
  /** An explicit seek before loadeddata must not be snapped back to the trim
   * start when the metadata arrives. */
  #explicitSeek = false

  seekToMs(timeMs: number): void {
    const el = this.#video
    if (!el) return
    this.#explicitSeek = true
    el.pause()
    this.#setPlaying(false)
    const sec = Math.max(0, Math.min(timeMs, this.props.clip.durationMs)) / 1000
    if (Math.abs(el.currentTime - sec) > 0.02) {
      el.currentTime = sec
    } else {
      nudgeFrame(el)
    }
  }

  pause(): void {
    const el = this.#video
    if (!el) return
    el.pause()
    this.#setPlaying(false)
  }

  #setPlaying(next: boolean): void {
    if (this.#playing === next) return
    this.#playing = next
    this.#affordance?.replaceChildren(next ? iconPause(18) : iconPlay(18))
    this.#affordance?.setAttribute('aria-label', next ? 'Pause clip preview' : 'Play clip preview')
  }

  #togglePlayback(): void {
    const video = this.#video
    if (!video) return
    if (!video.paused) {
      video.pause()
      this.#setPlaying(false)
      return
    }
    const startSec = this.#startSec()
    const endSec = this.#endSec()
    const atEnd = video.currentTime >= endSec - 0.04
    const beforeStart = video.currentTime < startSec - 0.04
    if (atEnd || beforeStart) {
      video.currentTime = startSec
    }
    void video
      .play()
      .then(() => this.#setPlaying(true))
      .catch(() => this.#setPlaying(false))
  }

  #startSec(): number {
    return (this.props.trimOverride ? 0 : this.props.clip.trimStartMs) / 1000
  }
  #endSec(): number {
    return (this.props.trimOverride ? this.props.clip.durationMs : this.props.clip.trimEndMs) / 1000
  }

  override render(): void {
    const { clip } = this.props
    this.#explicitSeek = false
    const video = h('video', {
      className: 'editor-clip-preview',
      playsInline: true,
      preload: 'auto',
      src: this.blobUrl(clip.blob),
      onloadeddata: () => {
        // Don't clobber a seek the user already made while loading.
        if (this.#explicitSeek) return
        if (Math.abs(video.currentTime - this.#startSec()) > 0.04) {
          video.currentTime = this.#startSec()
          return
        }
        nudgeFrame(video)
      },
      onseeked: () => {
        if (video.paused) nudgeFrame(video)
      },
      ontimeupdate: () => {
        if (!video.paused && video.currentTime >= this.#endSec() - 0.02) {
          video.pause()
          video.currentTime = this.#endSec()
          this.#setPlaying(false)
        }
      },
      onpause: () => this.#setPlaying(false),
      onplay: () => this.#setPlaying(true),
      onclick: () => this.#togglePlayback(),
    })
    this.#video = video
    this.#affordance = h(
      'button',
      {
        type: 'button',
        className: 'editor-preview-affordance',
        'aria-label': 'Play clip preview',
        onclick: () => this.#togglePlayback(),
      },
      iconPlay(18),
    )
    this.replaceChildren(
      h('div', { className: 'editor-clip-preview-wrap' }, video, this.#affordance),
    )
  }
}
define('kv-clip-preview', KvClipPreview)
