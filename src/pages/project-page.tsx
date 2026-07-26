import { startTransition, useCallback, useRef, useState } from 'react'
import {
  Link,
  useLoaderData,
  useNavigate,
  useParams,
  useRevalidator,
  type LoaderFunctionArgs,
} from 'react-router-dom'
import { ExportSheet } from '../components/export-sheet'
import { PlaybackOverlay } from '../components/playback-overlay'
import { Timeline } from '../components/timeline'
import { TrimSheet } from '../components/trim-sheet'
import { useCamera } from '../hooks/use-camera'
import {
  appendRecording,
  duplicateSelectedClip,
  loadProjectPage,
  moveSelectedClip,
  removeClip,
  trimClip,
  undoLastDelete,
  type ProjectLoaderData,
} from '../lib/project-actions'
import {
  downloadClipsAsSeparateFiles,
  exportProjectAsWebm,
  projectFilename,
  shareOrDownload,
} from '../lib/media'
import { HoldRecorder } from '../lib/recorder'
import { effectiveDurationMs, formatDuration, type ClipId } from '../lib/types'

type Sheet = 'none' | 'trim' | 'export'

export async function projectLoader({ params }: LoaderFunctionArgs): Promise<ProjectLoaderData> {
  const projectId = params.projectId
  if (!projectId) {
    return { project: null, clips: [], canUndo: false, error: 'Project not found' }
  }
  return loadProjectPage(projectId)
}

export function ProjectPage() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const data = useLoaderData() as ProjectLoaderData
  const revalidator = useRevalidator()
  const camera = useCamera()

  const recorderRef = useRef(new HoldRecorder())
  const pointerIdRef = useRef<number | null>(null)
  const recordRafRef = useRef(0)
  const toastTimerRef = useRef(0)

  const [selectedClipId, setSelectedClipId] = useState<ClipId | null>(
    () => data.clips.at(-1)?.id ?? null,
  )
  const [recording, setRecording] = useState(false)
  const [recordMs, setRecordMs] = useState(0)
  const [sheet, setSheet] = useState<Sheet>('none')
  const [playing, setPlaying] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [exportProgress, setExportProgress] = useState<number | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportMessage, setExportMessage] = useState<string | null>(null)

  const totalDurationMs = data.clips.reduce((sum, clip) => sum + effectiveDurationMs(clip), 0)

  // Derive a valid selection from loader data (avoid syncing with an effect).
  const resolvedSelectedId =
    selectedClipId && data.clips.some((c) => c.id === selectedClipId)
      ? selectedClipId
      : (data.clips.at(-1)?.id ?? null)
  const selected = data.clips.find((c) => c.id === resolvedSelectedId) ?? null

  const refresh = useCallback(() => {
    startTransition(() => {
      void revalidator.revalidate()
    })
  }, [revalidator])

  const showToast = useCallback((message: string) => {
    window.clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2200)
  }, [])

  const stopRecordTicker = useCallback(() => {
    cancelAnimationFrame(recordRafRef.current)
    recordRafRef.current = 0
  }, [])

  const beginRecord = useCallback(
    (pointerId: number) => {
      if (recording || playing || sheet !== 'none') return
      if (!camera.stream || !camera.isReady) {
        showToast('Camera not ready')
        return
      }
      pointerIdRef.current = pointerId
      try {
        recorderRef.current.start(camera.stream)
        setRecording(true)
        setRecordMs(0)
        const started = performance.now()
        const tick = () => {
          setRecordMs(performance.now() - started)
          recordRafRef.current = requestAnimationFrame(tick)
        }
        recordRafRef.current = requestAnimationFrame(tick)
      } catch {
        showToast('Could not start recording')
        pointerIdRef.current = null
      }
    },
    [camera.isReady, camera.stream, playing, recording, sheet, showToast],
  )

  const endRecord = useCallback(
    async (pointerId?: number) => {
      if (pointerId !== undefined && pointerIdRef.current !== pointerId) return
      if (!recorderRef.current.isRecording && !recording) return
      pointerIdRef.current = null
      stopRecordTicker()
      setRecording(false)
      try {
        const result = await recorderRef.current.stop()
        if (!result) {
          showToast('Hold a bit longer')
          return
        }
        if (!projectId) return
        const clip = await appendRecording(projectId, result)
        setSelectedClipId(clip.id)
        refresh()
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Save failed')
      }
    },
    [projectId, recording, refresh, showToast, stopRecordTicker],
  )

  if (!projectId) {
    navigate('/')
    return null
  }

  if (data.error || !data.project) {
    return (
      <div className="screen">
        <div className="error-banner">{data.error ?? 'Project missing'}</div>
        <div style={{ marginTop: 16 }}>
          <Link className="btn btn-secondary" to="/">
            Back home
          </Link>
        </div>
      </div>
    )
  }

  const needsPermission =
    camera.permission.status === 'denied' ||
    camera.permission.status === 'unsupported' ||
    (!!camera.error && !camera.isReady)

  const attachCameraVideo = camera.videoRef
  const bindCameraVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      if (!element) {
        stopRecordTicker()
        recorderRef.current.cancel()
        window.clearTimeout(toastTimerRef.current)
      }
      attachCameraVideo(element)
    },
    [attachCameraVideo, stopRecordTicker],
  )

  return (
    <div className="screen camera-screen">
      <div className="camera-top">
        <Link
          to="/"
          className="btn-icon"
          aria-label="Back to projects"
          onClick={() => {
            stopRecordTicker()
            recorderRef.current.cancel()
            window.clearTimeout(toastTimerRef.current)
          }}
        >
          ←
        </Link>
        <div className="camera-meta">
          <strong>{data.project.name}</strong>
          <small className="muted">{formatDuration(totalDurationMs)} total</small>
        </div>
        <button
          type="button"
          className="btn-icon"
          aria-label="Flip camera"
          disabled={!camera.canFlip || recording}
          onClick={() => void camera.flip()}
        >
          ↻
        </button>
      </div>

      <div
        className="camera-stage"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          beginRecord(event.pointerId)
        }}
        onPointerUp={(event) => {
          void endRecord(event.pointerId)
        }}
        onPointerCancel={(event) => {
          void endRecord(event.pointerId)
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <video
          ref={bindCameraVideo}
          className={`camera-video${camera.facing === 'user' ? ' mirror' : ''}`}
          muted
          playsInline
          autoPlay
        />

        {recording ? (
          <div className="record-overlay">
            <div className="record-pill" aria-live="polite">
              <span className="record-dot" />
              REC {formatDuration(recordMs)}
            </div>
          </div>
        ) : null}

        {!recording && data.clips.length === 0 && camera.isReady ? (
          <div className="hold-hint">Hold anywhere to record</div>
        ) : null}

        {needsPermission ? (
          <div className="permission-panel">
            <div>
              <h2>Camera access</h2>
              <p>
                {camera.error ??
                  camera.permission.message ??
                  'Allow camera and microphone to record clips on this device.'}
              </p>
              <button type="button" className="btn btn-primary" onClick={() => void camera.start()}>
                Try again
              </button>
            </div>
          </div>
        ) : null}

        {playing ? (
          <PlaybackOverlay clips={data.clips} onClose={() => setPlaying(false)} />
        ) : null}
      </div>

      <div className="camera-bottom">
        <Timeline
          clips={data.clips}
          selectedClipId={resolvedSelectedId}
          onSelect={setSelectedClipId}
        />

        <div className="toolbar">
          <div className="toolbar-group">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!resolvedSelectedId || recording}
              onClick={() => {
                void (async () => {
                  if (!resolvedSelectedId) return
                  await removeClip(resolvedSelectedId)
                  setSelectedClipId(null)
                  refresh()
                  showToast('Clip deleted — undo available')
                })()
              }}
            >
              Delete
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!data.canUndo || recording}
              onClick={() => {
                void (async () => {
                  const restored = await undoLastDelete(projectId)
                  if (restored) setSelectedClipId(restored.id)
                  refresh()
                  showToast('Clip restored')
                })()
              }}
            >
              Undo
            </button>
          </div>
          <div className="toolbar-group">
            <button
              type="button"
              className="btn-icon"
              aria-label="Move clip left"
              disabled={!resolvedSelectedId || recording}
              onClick={() => {
                void (async () => {
                  if (!resolvedSelectedId) return
                  await moveSelectedClip(projectId, resolvedSelectedId, 'left')
                  refresh()
                })()
              }}
            >
              ‹
            </button>
            <button
              type="button"
              className="btn-icon"
              aria-label="Move clip right"
              disabled={!resolvedSelectedId || recording}
              onClick={() => {
                void (async () => {
                  if (!resolvedSelectedId) return
                  await moveSelectedClip(projectId, resolvedSelectedId, 'right')
                  refresh()
                })()
              }}
            >
              ›
            </button>
            <button
              type="button"
              className="btn-icon"
              aria-label="Duplicate clip"
              disabled={!resolvedSelectedId || recording}
              onClick={() => {
                void (async () => {
                  if (!resolvedSelectedId) return
                  const copy = await duplicateSelectedClip(resolvedSelectedId)
                  setSelectedClipId(copy.id)
                  refresh()
                })()
              }}
            >
              ⧉
            </button>
            <button
              type="button"
              className="btn-icon"
              aria-label="Trim clip"
              disabled={!selected || recording}
              onClick={() => setSheet('trim')}
            >
              ✂
            </button>
          </div>
        </div>

        <div className="toolbar">
          <button
            type="button"
            className="btn btn-secondary"
            style={{ flex: 1 }}
            disabled={data.clips.length === 0 || recording}
            onClick={() => setPlaying(true)}
          >
            Preview
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ flex: 1 }}
            disabled={data.clips.length === 0 || recording}
            onClick={() => {
              setExportMessage(null)
              setExportProgress(null)
              setSheet('export')
            }}
          >
            Share
          </button>
        </div>
      </div>

      {sheet === 'trim' && selected ? (
        <TrimSheet
          key={selected.id}
          clip={selected}
          onClose={() => setSheet('none')}
          onSave={async (trimStartMs, trimEndMs) => {
            await trimClip(selected.id, trimStartMs, trimEndMs)
            refresh()
          }}
        />
      ) : null}

      {sheet === 'export' ? (
        <ExportSheet
          projectName={data.project.name}
          progress={exportProgress}
          busy={exportBusy}
          message={exportMessage}
          onClose={() => {
            if (!exportBusy) setSheet('none')
          }}
          onDownloadClips={() => {
            downloadClipsAsSeparateFiles(data.clips, data.project!.name)
            setExportMessage('Started clip downloads (no upload).')
          }}
          onExport={() => {
            void (async () => {
              setExportBusy(true)
              setExportMessage(null)
              setExportProgress(0)
              try {
                const blob = await exportProjectAsWebm(data.clips, setExportProgress)
                const filename = projectFilename(data.project!.name)
                const mode = await shareOrDownload(blob, filename)
                setExportMessage(
                  mode === 'shared'
                    ? 'Shared from this device.'
                    : 'Downloaded. Nothing was uploaded.',
                )
              } catch (err) {
                setExportMessage(
                  err instanceof Error
                    ? `${err.message} Try “Files” for separate downloads.`
                    : 'Export failed. Try downloading clips separately.',
                )
              } finally {
                setExportBusy(false)
                setExportProgress(null)
              }
            })()
          }}
        />
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
