/**
 * Editor: filmstrip timeline, clip preview stage, trim, reorder, duplicate,
 * delete with undo. Skeleton built once; data changes sync the children.
 */

import { define, h, KvElement, type Child } from '../dom.ts'
import { isInteractiveTarget } from '../lib/keyboard.ts'
import {
  duplicateSelectedClip,
  moveSelectedClip,
  removeClip,
  trimClip,
  undoLastDelete,
} from '../lib/project-actions.ts'
import { refineClipFilmstrip, THUMB_COUNT } from '../lib/thumbs.ts'
import {
  effectiveDurationMs,
  formatDuration,
  type ClipId,
  type ClipRecord,
  type Project,
} from '../lib/types.ts'
import {
  iconBack,
  iconChevronLeft,
  iconChevronRight,
  iconDuplicate,
  iconPlay,
  iconTrash,
  iconTrim,
  iconUndo,
} from './icons.ts'
import { KvClipPreview } from './clip-preview.ts'
import { KvTimeline } from './timeline.ts'
import { KvTrimStrip } from './trim-strip.ts'
import type { ShowToast } from './record-screen.ts'

export interface EditorScreenProps {
  project: Project
  clips: ClipRecord[]
  canUndo: boolean
  /** True while a full-screen overlay owns input (playback, export, …). */
  interactionLocked: boolean
  onOpenCamera: () => void
  onOpenExport: () => void
  onPlay: () => void
  showToast: ShowToast
  refresh: () => void
}

interface EditorScreenEls {
  root: HTMLDivElement
  top: HTMLDivElement
  meta: HTMLElement
  playTop: HTMLButtonElement
  stage: HTMLDivElement
  panel: HTMLDivElement
  panelStrip: HTMLDivElement
  timeline: KvTimeline
  trimStrip: KvTrimStrip | null
  actions: HTMLDivElement
  deleteAction: HTMLButtonElement
  duplicateAction: HTMLButtonElement
  trimAction: HTMLButtonElement
  leftAction: HTMLButtonElement
  rightAction: HTMLButtonElement
  toolbar: HTMLDivElement
  undoButton: HTMLButtonElement
  goButton: HTMLButtonElement
  keyHints: HTMLDivElement
}

export class KvEditorScreen extends KvElement<EditorScreenProps> {
  #selectedClipId: ClipId | null = null
  #trimming = false
  #preview: KvClipPreview | null = null
  #previewKey: string | null = null
  #refineAttempted = new Set<ClipId>()
  els = {} as EditorScreenEls

  override update(): void {
    this.sync()
  }

  // Derive a valid selection from the loaded clips (no state syncing).
  #resolveSelectedId(): ClipId | null {
    const clips = this.props.clips
    return this.#selectedClipId && clips.some((c) => c.id === this.#selectedClipId)
      ? this.#selectedClipId
      : (clips.at(-1)?.id ?? null)
  }

  #setSelectedClipId(id: ClipId): void {
    this.#selectedClipId = id
    this.sync()
  }

  #setTrimming(next: boolean): void {
    this.#trimming = next
    this.sync()
  }

  #handleDelete(): void {
    const id = this.#resolveSelectedId()
    if (!id) return
    void (async () => {
      await removeClip(id)
      this.#selectedClipId = null
      this.#trimming = false
      this.sync()
      this.props.refresh()
      this.props.showToast('Clip deleted', {
        actionLabel: 'Undo',
        onAction: () => {
          void (async () => {
            const restored = await undoLastDelete(this.props.project.id)
            if (restored) this.#setSelectedClipId(restored.id)
            this.props.refresh()
            this.props.showToast('Clip restored')
          })()
        },
      })
    })()
  }

  #duplicateSelected(): void {
    const id = this.#resolveSelectedId()
    if (!id) return
    void duplicateSelectedClip(id).then((copy) => {
      this.#setSelectedClipId(copy.id)
      this.props.refresh()
    })
  }

  #moveSelected(direction: 'left' | 'right'): void {
    const id = this.#resolveSelectedId()
    if (!id) return
    void moveSelectedClip(this.props.project.id, id, direction).then(() => this.props.refresh())
  }

  // Desktop keyboard support. Handlers read live state — no re-binding.
  onWindowKeyDown = (event: KeyboardEvent): void => {
    if (this.props.interactionLocked) return
    // Escape stays global; everything else yields to focused controls.
    if (event.code !== 'Escape' && isInteractiveTarget(event)) return
    const clips = this.props.clips
    const resolvedSelectedId = this.#resolveSelectedId()
    const selected = clips.find((c) => c.id === resolvedSelectedId) ?? null
    const selectedIndex = selected ? clips.findIndex((c) => c.id === selected.id) : -1
    if (event.code === 'Escape') {
      if (this.#trimming) {
        this.#preview?.pause()
        this.#setTrimming(false)
      } else {
        this.props.onOpenCamera()
      }
      return
    }
    if (this.#trimming) return
    switch (event.code) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (clips.length === 0) return
        event.preventDefault()
        const step = event.code === 'ArrowLeft' ? -1 : 1
        if (event.altKey) {
          // Alt+arrow reorders, matching the Left/Right buttons.
          if (!resolvedSelectedId) return
          const atEdge = step < 0 ? selectedIndex <= 0 : selectedIndex >= clips.length - 1
          if (atEdge) return
          this.#moveSelected(step < 0 ? 'left' : 'right')
          return
        }
        const nextIndex = Math.min(
          clips.length - 1,
          Math.max(0, (selectedIndex < 0 ? clips.length - 1 : selectedIndex) + step),
        )
        this.#setSelectedClipId(clips[nextIndex].id)
        return
      }
      case 'Backspace':
      case 'Delete': {
        event.preventDefault()
        this.#handleDelete()
        return
      }
      case 'KeyT': {
        if (!selected) return
        this.#preview?.pause()
        this.#setTrimming(true)
        return
      }
      case 'KeyD': {
        this.#duplicateSelected()
        return
      }
      case 'KeyP': {
        if (clips.length > 0) this.props.onPlay()
        return
      }
      default:
        return
    }
  }

  /**
   * New recordings carry a single live-captured frame. Here the camera is
   * released, so upgrade them to the real evenly-spaced strip. Checked
   * after every sync with a per-clip attempted set.
   */
  #refineFilmstrips(): void {
    const clips = this.props.clips
    // Ids leave the attempted set when their clip leaves the list (a
    // delete + undo restores a snapshot that may predate the refinement).
    const ids = new Set(clips.map((clip) => clip.id))
    for (const id of this.#refineAttempted) {
      if (!ids.has(id)) this.#refineAttempted.delete(id)
    }
    const pending = clips.filter((clip) => {
      const count = clip.thumbs?.length ?? 0
      return count > 0 && count < THUMB_COUNT && !this.#refineAttempted.has(clip.id)
    })
    if (pending.length === 0) return
    for (const clip of pending) {
      this.#refineAttempted.add(clip.id)
    }
    // Serial: Android caps concurrent video decoders hard.
    void (async () => {
      for (const clip of pending) {
        await refineClipFilmstrip(clip)
      }
      this.props.refresh()
    })()
  }

  override render(): void {
    const els = this.els
    const { project, onOpenCamera, onOpenExport, onPlay } = this.props
    this.#selectedClipId = this.props.clips.at(-1)?.id ?? null

    els.meta = h('small')
    els.playTop = h(
      'button',
      {
        type: 'button',
        className: 'btn-icon',
        'aria-label': 'Play project preview',
        onclick: () => onPlay(),
      },
      iconPlay(),
    )
    els.top = h(
      'div',
      { className: 'editor-top' },
      h(
        'button',
        {
          type: 'button',
          className: 'btn-icon',
          'aria-label': 'Back to camera',
          onclick: () => onOpenCamera(),
        },
        iconBack(),
      ),
      h('div', { className: 'editor-meta' }, h('strong', null, project.name), els.meta),
      els.playTop,
    )

    els.stage = h('div', { className: 'editor-stage' })

    els.timeline = new KvTimeline()
    // Transparent container so the panel's flex layout sees the timeline /
    // trim strip as its direct child.
    els.panelStrip = h('div', { style: { display: 'contents' } }, els.timeline)

    const action = (
      label: string,
      icon: SVGSVGElement,
      onclick: () => void,
      {
        ariaLabel,
        prominent,
        danger,
      }: { ariaLabel?: string; prominent?: boolean; danger?: boolean } = {},
    ): HTMLButtonElement => {
      const button = h(
        'button',
        {
          type: 'button',
          className: `editor-action${prominent ? ' prominent' : ''}${danger ? ' danger' : ''}`,
          'aria-label': ariaLabel ?? label,
          onclick,
        },
        h('span', { className: 'editor-action-icon' }, icon),
        h('span', { className: 'editor-action-label' }, label),
      )
      return button
    }
    els.deleteAction = action('Delete', iconTrash(), () => this.#handleDelete(), {
      ariaLabel: 'Delete clip',
      danger: true,
    })
    els.duplicateAction = action('Duplicate', iconDuplicate(), () => this.#duplicateSelected(), {
      ariaLabel: 'Duplicate clip',
    })
    els.trimAction = action(
      'Trim',
      iconTrim(),
      () => {
        this.#preview?.pause()
        this.#setTrimming(true)
      },
      { prominent: true },
    )
    els.leftAction = action('Left', iconChevronLeft(), () => this.#moveSelected('left'), {
      ariaLabel: 'Move clip left',
    })
    els.rightAction = action('Right', iconChevronRight(), () => this.#moveSelected('right'), {
      ariaLabel: 'Move clip right',
    })
    els.actions = h(
      'div',
      { className: 'editor-actions', role: 'toolbar', 'aria-label': 'Clip actions' },
      els.deleteAction,
      els.duplicateAction,
      els.trimAction,
      els.leftAction,
      els.rightAction,
    )

    els.undoButton = h(
      'button',
      {
        type: 'button',
        className: 'btn btn-ghost',
        onclick: () => {
          void (async () => {
            const restored = await undoLastDelete(project.id)
            if (restored) this.#setSelectedClipId(restored.id)
            this.props.refresh()
            this.props.showToast('Clip restored')
          })()
        },
      },
      iconUndo(18),
      ' Undo delete',
    )
    els.goButton = h(
      'button',
      { type: 'button', className: 'go-button compact', onclick: () => onOpenExport() },
      'Go',
    )
    els.toolbar = h('div', { className: 'editor-toolbar' }, els.undoButton, els.goButton)

    els.keyHints = h('div', { className: 'key-hints', 'aria-hidden': 'true' })
    els.keyHints.innerHTML =
      '<kbd>←</kbd>/<kbd>→</kbd> select · <kbd>Alt</kbd>+arrows move · <kbd>T</kbd> trim · ' +
      '<kbd>D</kbd> duplicate · <kbd>⌫</kbd> delete · <kbd>P</kbd> play · <kbd>Esc</kbd> camera'

    els.panel = h(
      'div',
      { className: 'editor-panel' },
      els.panelStrip,
      els.actions,
      els.toolbar,
      els.keyHints,
    )

    els.root = h('div', { className: 'editor-screen' }, els.top, els.stage, els.panel)
    this.replaceChildren(els.root)

    window.addEventListener('keydown', this.onWindowKeyDown)
    this.signal.addEventListener('abort', () => {
      window.removeEventListener('keydown', this.onWindowKeyDown)
    })

    this.sync()
  }

  sync(): void {
    const els = this.els
    if (!els.root || !this.isConnected) return
    const { project, clips, canUndo } = this.props
    const totalDurationMs = clips.reduce((sum, clip) => sum + effectiveDurationMs(clip), 0)
    const resolvedSelectedId = this.#resolveSelectedId()
    const selected = clips.find((c) => c.id === resolvedSelectedId) ?? null
    const selectedIndex = selected ? clips.findIndex((c) => c.id === selected.id) : -1
    if (!selected) this.#trimming = false

    this.#refineFilmstrips()

    els.root.classList.toggle('is-trimming', this.#trimming)
    els.meta.textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${formatDuration(totalDurationMs)}`
    els.playTop.disabled = clips.length === 0

    // Stage preview: keyed remount when the clip identity/trim changes.
    if (selected) {
      const key = `${selected.id}:${selected.blob.size}:${selected.blob.type}:${selected.trimStartMs}:${selected.trimEndMs}:${this.#trimming}`
      if (key !== this.#previewKey) {
        this.#previewKey = key
        const preview = new KvClipPreview()
        preview.props = {
          clip: selected,
          // While trimming, show the full clip so handle seeks are visible.
          trimOverride: this.#trimming,
        }
        this.#preview = preview
        els.stage.replaceChildren(preview)
      }
    } else {
      this.#previewKey = null
      this.#preview = null
      els.stage.replaceChildren(
        h('div', { className: 'editor-empty-preview' }, 'Select a clip in the timeline'),
      )
    }

    // Timeline vs trim strip.
    if (this.#trimming && selected) {
      if (!els.trimStrip || els.trimStrip.props.clip.id !== selected.id) {
        const trimStrip = new KvTrimStrip()
        trimStrip.props = {
          clip: selected,
          onSeek: (timeMs) => this.#preview?.seekToMs(timeMs),
          onCancel: () => {
            this.#preview?.pause()
            this.#setTrimming(false)
          },
          onDone: async (trimStartMs, trimEndMs) => {
            await trimClip(selected.id, trimStartMs, trimEndMs)
            this.props.refresh()
            this.#preview?.pause()
            this.#setTrimming(false)
          },
        }
        els.trimStrip = trimStrip
        els.panelStrip.replaceChildren(els.trimStrip)
      }
    } else {
      els.trimStrip = null
      els.timeline.props = {
        projectId: project.id,
        clips,
        selectedClipId: resolvedSelectedId,
        onSelect: (id) => {
          this.#selectedClipId = id
          this.#trimming = false
          this.sync()
        },
        refresh: this.props.refresh,
      }
      if (els.timeline.parentNode !== els.panelStrip || els.panelStrip.firstChild !== els.timeline) {
        els.panelStrip.replaceChildren(els.timeline)
      }
      els.timeline.update()
    }
    els.actions.hidden = this.#trimming

    els.deleteAction.disabled = !selected
    els.duplicateAction.disabled = !selected
    els.trimAction.disabled = !selected
    els.leftAction.disabled = !selected || selectedIndex <= 0
    els.rightAction.disabled = !selected || selectedIndex >= clips.length - 1
    els.undoButton.disabled = !canUndo
    els.goButton.disabled = clips.length === 0
  }
}
define('kv-editor-screen', KvEditorScreen)
