import type { Handle, RemixNode } from 'remix/ui'
import { on, ref } from 'remix/ui'
import '../styles/editor.css'
import {
  duplicateSelectedClip,
  moveSelectedClip,
  removeClip,
  trimClip,
  undoLastDelete,
} from '../lib/project-actions'
import {
  effectiveDurationMs,
  formatDuration,
  type ClipId,
  type ClipRecord,
  type Project,
} from '../lib/types'
import { EditorClipPreview, type EditorClipPreviewHandle } from './editor-clip-preview'
import {
  IconBack,
  IconChevronLeft,
  IconChevronRight,
  IconDuplicate,
  IconPlay,
  IconTrash,
  IconTrim,
  IconUndo,
} from './icons'
import { Timeline } from './timeline'
import { TrimStrip } from './trim-strip'
import type { ToastAction } from './record-screen'
import { isInteractiveTarget } from '../lib/keyboard'
import { THUMB_COUNT, refineClipFilmstrip } from '../lib/thumbs'

interface EditorScreenProps {
  project: Project
  clips: ClipRecord[]
  canUndo: boolean
  /** True while a full-screen overlay owns input (playback, export, …). */
  interactionLocked: boolean
  onOpenCamera: () => void
  onOpenExport: () => void
  onPlay: () => void
  showToast: (message: string, action?: ToastAction) => void
  refresh: () => void
}

export function EditorScreen(handle: Handle<EditorScreenProps>) {
  const { props } = handle
  let selectedClipId: ClipId | null = props.clips.at(-1)?.id ?? null
  let trimming = false
  const previewApi: { current: EditorClipPreviewHandle | null } = { current: null }

  // Derive a valid selection from the loaded clips (no state syncing).
  const resolveSelectedId = (): ClipId | null =>
    selectedClipId && props.clips.some((c) => c.id === selectedClipId)
      ? selectedClipId
      : (props.clips.at(-1)?.id ?? null)

  const setSelectedClipId = (id: ClipId | null) => {
    selectedClipId = id
    void handle.update()
  }
  const setTrimming = (next: boolean) => {
    trimming = next
    void handle.update()
  }

  const handleDelete = () => {
    const id = resolveSelectedId()
    if (!id) return
    void (async () => {
      await removeClip(id)
      selectedClipId = null
      trimming = false
      void handle.update()
      props.refresh()
      props.showToast('Clip deleted', {
        actionLabel: 'Undo',
        onAction: () => {
          void (async () => {
            const restored = await undoLastDelete(props.project.id)
            if (restored) setSelectedClipId(restored.id)
            props.refresh()
            props.showToast('Clip restored')
          })()
        },
      })
    })()
  }

  // Desktop keyboard support. Closures read live state — no re-binding.
  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (props.interactionLocked) return
    // Escape stays global; everything else yields to focused controls.
    if (event.code !== 'Escape' && isInteractiveTarget(event)) return
    const clips = props.clips
    const resolvedSelectedId = resolveSelectedId()
    const selected = clips.find((c) => c.id === resolvedSelectedId) ?? null
    const selectedIndex = selected ? clips.findIndex((c) => c.id === selected.id) : -1
    if (event.code === 'Escape') {
      if (trimming) {
        previewApi.current?.pause()
        setTrimming(false)
      } else {
        props.onOpenCamera()
      }
      return
    }
    if (trimming) return
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
          void moveSelectedClip(
            props.project.id,
            resolvedSelectedId,
            step < 0 ? 'left' : 'right',
          ).then(() => props.refresh())
          return
        }
        const nextIndex = Math.min(
          clips.length - 1,
          Math.max(0, (selectedIndex < 0 ? clips.length - 1 : selectedIndex) + step),
        )
        setSelectedClipId(clips[nextIndex].id)
        return
      }
      case 'Backspace':
      case 'Delete': {
        event.preventDefault()
        handleDelete()
        return
      }
      case 'KeyT': {
        if (!selected) return
        previewApi.current?.pause()
        setTrimming(true)
        return
      }
      case 'KeyD': {
        if (!resolvedSelectedId) return
        void duplicateSelectedClip(resolvedSelectedId).then((copy) => {
          setSelectedClipId(copy.id)
          props.refresh()
        })
        return
      }
      case 'KeyP': {
        if (clips.length > 0) props.onPlay()
        return
      }
      default:
        return
    }
  }

  // New recordings carry a single live-captured frame (decoding for a full
  // filmstrip behind the live camera preview causes the post-take black
  // flash). Here the camera is released, so upgrade them to the real
  // evenly-spaced strip. Checked after every render with a per-clip attempted
  // set — clips can also arrive through later refreshes (duplicates, undo),
  // not just the mount.
  const refineAttempted = new Set<string>()
  const refineFilmstrips = () => {
    // Ids leave the attempted set when their clip leaves the list: a
    // delete + undo restores the clip from a snapshot that may predate the
    // refinement, and it must get another shot. Clips still present keep
    // their entry, so a failed refinement can't refresh-loop.
    const ids = new Set(props.clips.map((clip) => clip.id))
    for (const id of refineAttempted) {
      if (!ids.has(id)) refineAttempted.delete(id)
    }
    const pending = props.clips.filter((clip) => {
      const count = clip.thumbs?.length ?? 0
      return count > 0 && count < THUMB_COUNT && !refineAttempted.has(clip.id)
    })
    if (pending.length === 0) return
    for (const clip of pending) {
      refineAttempted.add(clip.id)
    }
    // Serial, like the loader backfill: Android caps concurrent video
    // decoders hard, and each refinement decodes a clip.
    void (async () => {
      for (const clip of pending) {
        await refineClipFilmstrip(clip)
      }
      props.refresh()
    })()
  }

  return () => {
    const { project, clips, canUndo, onOpenCamera, onOpenExport, onPlay } = props
    const totalDurationMs = clips.reduce((sum, clip) => sum + effectiveDurationMs(clip), 0)
    const resolvedSelectedId = resolveSelectedId()
    const selected = clips.find((c) => c.id === resolvedSelectedId) ?? null
    const selectedIndex = selected ? clips.findIndex((c) => c.id === selected.id) : -1

    refineFilmstrips()

    return (
      <div
        className={`editor-screen${trimming ? ' is-trimming' : ''}`}
        mix={ref((_node, signal) => {
          window.addEventListener('keydown', onWindowKeyDown)
          signal.addEventListener('abort', () => {
            window.removeEventListener('keydown', onWindowKeyDown)
          })
        })}
      >
        <div className="editor-top">
          <button
            type="button"
            className="btn-icon"
            aria-label="Back to camera"
            mix={on('click', () => onOpenCamera())}
          >
            <IconBack />
          </button>
          <div className="editor-meta">
            <strong>{project.name}</strong>
            <small>
              {clips.length} clip{clips.length === 1 ? '' : 's'} · {formatDuration(totalDurationMs)}
            </small>
          </div>
          <button
            type="button"
            className="btn-icon"
            aria-label="Play project preview"
            disabled={clips.length === 0}
            mix={on('click', () => onPlay())}
          >
            <IconPlay />
          </button>
        </div>

        <div className="editor-stage">
          {selected ? (
            <EditorClipPreview
              key={selected.id}
              clip={
                trimming
                  ? {
                      ...selected,
                      // While trimming, show full clip so handle seeks are visible.
                      trimStartMs: 0,
                      trimEndMs: selected.durationMs,
                    }
                  : selected
              }
              apiRef={previewApi}
            />
          ) : (
            <div className="editor-empty-preview">Select a clip in the timeline</div>
          )}
        </div>

        <div className="editor-panel">
          {trimming && selected ? (
            <TrimStrip
              key={selected.id}
              clip={selected}
              onSeek={(timeMs) => previewApi.current?.seekToMs(timeMs)}
              onCancel={() => {
                previewApi.current?.pause()
                setTrimming(false)
              }}
              onDone={async (trimStartMs, trimEndMs) => {
                await trimClip(selected.id, trimStartMs, trimEndMs)
                props.refresh()
                previewApi.current?.pause()
                setTrimming(false)
              }}
            />
          ) : (
            <Timeline
              projectId={project.id}
              clips={clips}
              selectedClipId={resolvedSelectedId}
              onSelect={(id) => {
                selectedClipId = id
                trimming = false
                void handle.update()
              }}
              refresh={props.refresh}
            />
          )}

          {!trimming ? (
            <div className="editor-actions" role="toolbar" aria-label="Clip actions">
              <ActionButton
                label="Delete"
                ariaLabel="Delete clip"
                disabled={!selected}
                tone="danger"
                onClick={handleDelete}
                icon={<IconTrash />}
              />
              <ActionButton
                label="Duplicate"
                ariaLabel="Duplicate clip"
                disabled={!selected}
                onClick={() => {
                  if (!resolvedSelectedId) return
                  void duplicateSelectedClip(resolvedSelectedId).then((copy) => {
                    setSelectedClipId(copy.id)
                    props.refresh()
                  })
                }}
                icon={<IconDuplicate />}
              />
              <ActionButton
                label="Trim"
                disabled={!selected}
                prominent
                onClick={() => {
                  previewApi.current?.pause()
                  setTrimming(true)
                }}
                icon={<IconTrim />}
              />
              <ActionButton
                label="Left"
                ariaLabel="Move clip left"
                disabled={!selected || selectedIndex <= 0}
                onClick={() => {
                  if (!resolvedSelectedId) return
                  void moveSelectedClip(project.id, resolvedSelectedId, 'left').then(() =>
                    props.refresh(),
                  )
                }}
                icon={<IconChevronLeft />}
              />
              <ActionButton
                label="Right"
                ariaLabel="Move clip right"
                disabled={!selected || selectedIndex >= clips.length - 1}
                onClick={() => {
                  if (!resolvedSelectedId) return
                  void moveSelectedClip(project.id, resolvedSelectedId, 'right').then(() =>
                    props.refresh(),
                  )
                }}
                icon={<IconChevronRight />}
              />
            </div>
          ) : null}

          <div className="editor-toolbar">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!canUndo}
              mix={on('click', () => {
                void (async () => {
                  const restored = await undoLastDelete(project.id)
                  if (restored) setSelectedClipId(restored.id)
                  props.refresh()
                  props.showToast('Clip restored')
                })()
              })}
            >
              <IconUndo size={18} />
              Undo delete
            </button>
            <button
              type="button"
              className="go-button compact"
              disabled={clips.length === 0}
              mix={on('click', () => onOpenExport())}
            >
              Go
            </button>
          </div>

          <div className="key-hints" aria-hidden="true">
            <kbd>←</kbd>/<kbd>→</kbd> select · <kbd>Alt</kbd>+arrows move · <kbd>T</kbd> trim ·{' '}
            <kbd>D</kbd> duplicate · <kbd>⌫</kbd> delete · <kbd>P</kbd> play · <kbd>Esc</kbd> camera
          </div>
        </div>
      </div>
    )
  }
}

function ActionButton(
  handle: Handle<{
    label: string
    ariaLabel?: string
    icon: RemixNode
    disabled?: boolean
    onClick: () => void
    prominent?: boolean
    tone?: 'danger'
  }>,
) {
  return () => {
    const { label, ariaLabel, icon, disabled, prominent, tone } = handle.props
    return (
      <button
        type="button"
        className={`editor-action${prominent ? ' prominent' : ''}${tone === 'danger' ? ' danger' : ''}`}
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        mix={on('click', () => handle.props.onClick())}
      >
        <span className="editor-action-icon">{icon}</span>
        <span className="editor-action-label">{label}</span>
      </button>
    )
  }
}
