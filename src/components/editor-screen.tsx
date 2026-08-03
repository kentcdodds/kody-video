import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  duplicateSelectedClip,
  moveSelectedClip,
  removeClip,
  trimClip,
  undoLastDelete,
} from '../lib/project-actions'
import { effectiveDurationMs, formatDuration, type ClipId, type ClipRecord, type Project } from '../lib/types'
import {
  EditorClipPreview,
  type EditorClipPreviewHandle,
} from './editor-clip-preview'
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

export function EditorScreen({
  project,
  clips,
  canUndo,
  interactionLocked,
  onOpenCamera,
  onOpenExport,
  onPlay,
  showToast,
  refresh,
}: EditorScreenProps) {
  const [selectedClipId, setSelectedClipId] = useState<ClipId | null>(
    () => clips.at(-1)?.id ?? null,
  )
  const [trimming, setTrimming] = useState(false)
  const previewApiRef = useRef<EditorClipPreviewHandle | null>(null)

  const totalDurationMs = clips.reduce((sum, clip) => sum + effectiveDurationMs(clip), 0)

  // Derive a valid selection from loader data (avoid syncing with an effect).
  const resolvedSelectedId =
    selectedClipId && clips.some((c) => c.id === selectedClipId)
      ? selectedClipId
      : (clips.at(-1)?.id ?? null)
  const selected = clips.find((c) => c.id === resolvedSelectedId) ?? null
  const selectedIndex = selected ? clips.findIndex((c) => c.id === selected.id) : -1

  const handleDelete = () => {
    if (!resolvedSelectedId) return
    void (async () => {
      await removeClip(resolvedSelectedId)
      setSelectedClipId(null)
      setTrimming(false)
      refresh()
      showToast('Clip deleted', {
        actionLabel: 'Undo',
        onAction: () => {
          void (async () => {
            const restored = await undoLastDelete(project.id)
            if (restored) setSelectedClipId(restored.id)
            refresh()
            showToast('Clip restored')
          })()
        },
      })
    })()
  }

  // Desktop keyboard support; the stable listener reads the latest committed
  // handler through a ref, re-assigned after every commit.
  const keyActionRef = useRef<(event: KeyboardEvent) => void>(() => undefined)
  const keyAction = (event: KeyboardEvent) => {
    if (interactionLocked) return
    // Escape stays global; everything else yields to focused controls.
    if (event.code !== 'Escape' && isInteractiveTarget(event)) return
    if (event.code === 'Escape') {
      if (trimming) {
        previewApiRef.current?.pause()
        setTrimming(false)
      } else {
        onOpenCamera()
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
          void moveSelectedClip(project.id, resolvedSelectedId, step < 0 ? 'left' : 'right').then(
            refresh,
          )
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
        previewApiRef.current?.pause()
        setTrimming(true)
        return
      }
      case 'KeyD': {
        if (!resolvedSelectedId) return
        void duplicateSelectedClip(resolvedSelectedId).then((copy) => {
          setSelectedClipId(copy.id)
          refresh()
        })
        return
      }
      case 'KeyP': {
        if (clips.length > 0) onPlay()
        return
      }
      default:
        return
    }
  }
  useLayoutEffect(() => {
    keyActionRef.current = keyAction
  })
  const onWindowKeyDown = useCallback((event: KeyboardEvent) => {
    keyActionRef.current(event)
  }, [])
  // New recordings carry a single live-captured frame (decoding for a full
  // filmstrip behind the live camera preview causes the post-take black
  // flash). Here the camera is released, so upgrade them to the real
  // evenly-spaced strip. Runs after every commit with a per-clip attempted
  // set — clips can also arrive through later revalidations (duplicates,
  // stale-then-fresh loader data), not just the mount.
  const refineAttemptedRef = useRef<Set<string>>(new Set())
  useLayoutEffect(() => {
    const pending = clips.filter((clip) => {
      const count = clip.thumbs?.length ?? 0
      return count > 0 && count < THUMB_COUNT && !refineAttemptedRef.current.has(clip.id)
    })
    if (pending.length === 0) return
    for (const clip of pending) {
      refineAttemptedRef.current.add(clip.id)
    }
    void Promise.all(pending.map((clip) => refineClipFilmstrip(clip))).then(refresh)
  })

  const bindKeyboard = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) window.addEventListener('keydown', onWindowKeyDown)
      else window.removeEventListener('keydown', onWindowKeyDown)
    },
    [onWindowKeyDown],
  )

  return (
    <div className={`editor-screen${trimming ? ' is-trimming' : ''}`} ref={bindKeyboard}>
      <div className="editor-top">
        <button type="button" className="btn-icon" aria-label="Back to camera" onClick={onOpenCamera}>
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
          onClick={onPlay}
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
            apiRef={previewApiRef}
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
            onSeek={(timeMs) => previewApiRef.current?.seekToMs(timeMs)}
            onCancel={() => {
              previewApiRef.current?.pause()
              setTrimming(false)
            }}
            onDone={async (trimStartMs, trimEndMs) => {
              await trimClip(selected.id, trimStartMs, trimEndMs)
              refresh()
              previewApiRef.current?.pause()
              setTrimming(false)
            }}
          />
        ) : (
          <Timeline
            projectId={project.id}
            clips={clips}
            selectedClipId={resolvedSelectedId}
            onSelect={(id) => {
              setSelectedClipId(id)
              setTrimming(false)
            }}
            refresh={refresh}
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
                  refresh()
                })
              }}
              icon={<IconDuplicate />}
            />
            <ActionButton
              label="Trim"
              disabled={!selected}
              prominent
              onClick={() => {
                previewApiRef.current?.pause()
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
                void moveSelectedClip(project.id, resolvedSelectedId, 'left').then(refresh)
              }}
              icon={<IconChevronLeft />}
            />
            <ActionButton
              label="Right"
              ariaLabel="Move clip right"
              disabled={!selected || selectedIndex >= clips.length - 1}
              onClick={() => {
                if (!resolvedSelectedId) return
                void moveSelectedClip(project.id, resolvedSelectedId, 'right').then(refresh)
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
            onClick={() => {
              void (async () => {
                const restored = await undoLastDelete(project.id)
                if (restored) setSelectedClipId(restored.id)
                refresh()
                showToast('Clip restored')
              })()
            }}
          >
            <IconUndo size={18} />
            Undo delete
          </button>
          <button
            type="button"
            className="go-button compact"
            disabled={clips.length === 0}
            onClick={onOpenExport}
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

function ActionButton({
  label,
  ariaLabel,
  icon,
  disabled,
  onClick,
  prominent,
  tone,
}: {
  label: string
  ariaLabel?: string
  icon: ReactNode
  disabled?: boolean
  onClick: () => void
  prominent?: boolean
  tone?: 'danger'
}) {
  return (
    <button
      type="button"
      className={`editor-action${prominent ? ' prominent' : ''}${tone === 'danger' ? ' danger' : ''}`}
      disabled={disabled}
      aria-label={ariaLabel ?? label}
      onClick={onClick}
    >
      <span className="editor-action-icon">{icon}</span>
      <span className="editor-action-label">{label}</span>
    </button>
  )
}
