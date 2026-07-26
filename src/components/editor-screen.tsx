import { useRef, useState, type ReactNode } from 'react'
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
import { Timeline } from './timeline'
import { TrimStrip } from './trim-strip'
import type { ToastAction } from './record-screen'

interface EditorScreenProps {
  project: Project
  clips: ClipRecord[]
  canUndo: boolean
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

  return (
    <div className={`editor-screen${trimming ? ' is-trimming' : ''}`}>
      <div className="editor-top">
        <button type="button" className="btn-icon" aria-label="Back to camera" onClick={onOpenCamera}>
          ←
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
          ▶
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
              icon={
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
                  <path
                    d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM7 9h2v9H7V9z"
                    fill="currentColor"
                  />
                </svg>
              }
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
              icon={
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
                  <path
                    d="M8 7h11v14H8V7zm2 2v10h7V9h-7zM5 3h11v2H7v11H5V3z"
                    fill="currentColor"
                  />
                </svg>
              }
            />
            <ActionButton
              label="Trim"
              disabled={!selected}
              prominent
              onClick={() => {
                previewApiRef.current?.pause()
                setTrimming(true)
              }}
              icon={
                <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden>
                  <path
                    d="M7.5 3.5 3.5 7.5l4.8 4.8 1.4-1.4L6.3 7.5l2.6-2.6L7.5 3.5zm9 0-1.4 1.4 2.6 2.6-2.6 2.6 1.4 1.4 4-4-4-4zM8.3 14.7l-1.4 1.4 4 4 1.4-1.4-4-4zm7.4 0-4 4 1.4 1.4 4-4-1.4-1.4z"
                    fill="currentColor"
                  />
                </svg>
              }
            />
            <ActionButton
              label="Left"
              ariaLabel="Move clip left"
              disabled={!selected || selectedIndex <= 0}
              onClick={() => {
                if (!resolvedSelectedId) return
                void moveSelectedClip(project.id, resolvedSelectedId, 'left').then(refresh)
              }}
              icon={
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
                  <path d="M14.5 6 8.5 12l6 6 1.4-1.4L11.3 12l4.6-4.6L14.5 6z" fill="currentColor" />
                </svg>
              }
            />
            <ActionButton
              label="Right"
              ariaLabel="Move clip right"
              disabled={!selected || selectedIndex >= clips.length - 1}
              onClick={() => {
                if (!resolvedSelectedId) return
                void moveSelectedClip(project.id, resolvedSelectedId, 'right').then(refresh)
              }}
              icon={
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
                  <path d="M9.5 6 8.1 7.4 12.7 12l-4.6 4.6L9.5 18l6-6-6-6z" fill="currentColor" />
                </svg>
              }
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
            Undo delete
          </button>
          <button
            type="button"
            className="ok-button compact"
            disabled={clips.length === 0}
            onClick={onOpenExport}
          >
            OK
          </button>
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
