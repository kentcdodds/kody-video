import { startTransition, useCallback, useRef, useState } from 'react'
import {
  Link,
  Navigate,
  useLoaderData,
  useNavigate,
  useRevalidator,
  type LoaderFunctionArgs,
} from 'react-router-dom'
import { EditorScreen } from '../components/editor-screen'
import { ExportOverlay } from '../components/export-overlay'
import { ExportSheet, type ExportStatus } from '../components/export-sheet'
import { OnboardingOverlay } from '../components/onboarding-overlay'
import { PlaybackOverlay } from '../components/playback-overlay'
import { RecordScreen, type ToastAction } from '../components/record-screen'
import { useCamera } from '../hooks/use-camera'
import { RestoreSheet } from '../components/restore-sheet'
import { REMOVE_WATERMARK_LINK } from '../lib/entitlement'
import { clearExportMarker, markExportStarted, reportError } from '../lib/error-reporting'
import { exportProject, type ExportResult } from '../lib/export'
import { MediaElementFailureError } from '../lib/export/media-error'
import { wait } from '../lib/export/shared'
import {
  canShareFile,
  downloadBlob,
  downloadClipsAsSeparateFiles,
  isIosBrowser,
  projectFilename,
  shareFile,
} from '../lib/media'
import { loadProjectPage, type ProjectLoaderData } from '../lib/project-actions'
import { createProject, setOnboardingDismissed } from '../lib/storage'
import { requestPersistentStorage } from '../lib/storage-space'
import { NEW_PROJECT_ID, type ProjectId } from '../lib/types'

/** Resolve after the next animation frame (or a short timeout when rAF is busy). */
function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    requestAnimationFrame(() => finish())
    window.setTimeout(finish, 50)
  })
}

type ProjectMode = 'record' | 'editor'

interface ToastState extends Partial<ToastAction> {
  message: string
}

interface ExportUiState {
  status: ExportStatus
  progress: number
  result: ExportResult | null
  error: string | null
  notice: string | null
  /** Whether THIS export was stamped (entitlement can change mid-sheet). */
  watermarked: boolean
}

export async function projectLoader({ params }: LoaderFunctionArgs): Promise<ProjectLoaderData> {
  const projectId = params.projectId
  if (!projectId) {
    return {
      project: null,
      clips: [],
      canUndo: false,
      onboardingDismissed: true,
      watermarkRemoved: false,
      storage: null,
      locationTaggingEnabled: false,
      error: 'Project not found',
    }
  }
  return loadProjectPage(projectId)
}

export function ProjectPage() {
  const data = useLoaderData() as ProjectLoaderData
  const revalidator = useRevalidator()
  const camera = useCamera()

  const toastTimerRef = useRef(0)
  const exportRunRef = useRef(0)
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const bindPreviewCanvas = useCallback((element: HTMLCanvasElement | null) => {
    previewCanvasRef.current = element
  }, [])

  const [mode, setMode] = useState<ProjectMode>('record')
  const [onboardingOpen, setOnboardingOpen] = useState(() => !data.onboardingDismissed)
  const [playing, setPlaying] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [exportState, setExportState] = useState<ExportUiState | null>(null)
  const [restoring, setRestoring] = useState(false)
  /** In-flight share/save COUNT (concurrent actions must not clear each
   * other's busy state) — the export sheet must not dismiss while > 0. */
  const [exportActionCount, setExportActionCount] = useState(0)
  const beginExportAction = () => setExportActionCount((count) => count + 1)
  const endExportAction = () => setExportActionCount((count) => Math.max(0, count - 1))

  const refresh = useCallback(() => {
    startTransition(() => {
      void revalidator.revalidate()
    })
  }, [revalidator])

  const showToast = useCallback((message: string, action?: ToastAction) => {
    window.clearTimeout(toastTimerRef.current)
    setToast({ message, ...action })
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  const clips = data.clips
  const stopCamera = camera.stop
  const navigate = useNavigate()
  const project = data.project

  // Lazy creation: a "/project/new" project is persisted only when the
  // first clip finishes recording. The promise is memoized so overlapping
  // takes (or a camera take racing a screen take) create exactly one.
  const ensureProjectRef = useRef<Promise<ProjectId> | null>(null)
  const ensureProjectId = useCallback((): Promise<ProjectId> => {
    if (project && project.id !== NEW_PROJECT_ID) return Promise.resolve(project.id)
    ensureProjectRef.current ??= (async () => {
      try {
        const created = await createProject()
        // Their recordings should survive storage pressure.
        requestPersistentStorage()
        navigate(`/project/${created.id}`, { replace: true })
        return created.id
      } catch (err) {
        // A failed creation must not poison later attempts.
        ensureProjectRef.current = null
        throw err
      }
    })()
    return ensureProjectRef.current
  }, [navigate, project])

  const startExport = useCallback(() => {
    if (clips.length === 0) return
    const runId = exportRunRef.current + 1
    exportRunRef.current = runId

    // Unlock an AudioContext from this tap: the realtime engine needs it for
    // audio mixing, including when WebCodecs fails mid-export and we fall
    // back after the tap's activation has expired. WebCodecs ignores it.
    let audioContext: AudioContext | undefined
    try {
      audioContext = new AudioContext()
      if (audioContext.state === 'suspended') {
        void audioContext.resume().catch(() => undefined)
      }
    } catch {
      audioContext = undefined
    }

    const watermarked = !data.watermarkRemoved
    // Stop camera/mic immediately rather than waiting on record-screen
    // unmount. On iOS the combined mic+camera session can hold decoder
    // slots past the first paints, and WebKit reports that race as
    // MEDIA_ERR_SRC_NOT_SUPPORTED for an otherwise playable clip.
    stopCamera()
    setExportState({
      status: 'exporting',
      progress: 0,
      result: null,
      error: null,
      notice: null,
      watermarked,
    })
    // Long exports must survive the screen dimming: without a wake lock the
    // OS suspends the tab mid-export and the user returns to a restart.
    const wakeLockRef: { current: WakeLockSentinel | null; released: boolean } = {
      current: null,
      released: false,
    }
    void navigator.wakeLock
      ?.request('screen')
      .then((sentinel) => {
        if (wakeLockRef.released) {
          // The export finished before the request resolved — never leak.
          void sentinel.release().catch(() => undefined)
          return
        }
        wakeLockRef.current = sentinel
      })
      .catch(() => undefined)

    void (async () => {
      try {
        // Export unmounts record/editor so camera + preview video release.
        // Wait two frames so those hardware decoder slots free before we open
        // new ones — otherwise loadClipVideo can fail with a media error on
        // Android (KODY-VIDEO-4). Kept inside try/finally so canceling during
        // the wait still closes the tap-created AudioContext.
        await waitForNextPaint()
        await waitForNextPaint()
        // iOS WebKit frees hardware decoders asynchronously after stop();
        // two frames alone was enough on Android but not after the combined
        // mic+camera capture path.
        if (isIosBrowser()) await wait(400)
        if (exportRunRef.current !== runId) return

        // If the page dies mid-export (tab crash / OOM — no JS error fires),
        // this marker survives the reload and reports the death at next boot.
        markExportStarted({ clips: clips.length })
        const result = await exportProject(clips, {
          audioContext,
          watermark: watermarked,
          getPreviewCanvas: () => previewCanvasRef.current,
          onProgress: (ratio) => {
            if (exportRunRef.current !== runId) return
            setExportState((current) =>
              current && current.status === 'exporting'
                ? { ...current, progress: ratio }
                : current,
            )
          },
        })
        if (exportRunRef.current !== runId) return
        setExportState({
          status: 'ready',
          progress: 1,
          result,
          error: null,
          notice: null,
          watermarked,
        })
      } catch (err) {
        // Report even when the run was abandoned (closed sheet / retry) —
        // only the UI update is stale, the failure is real.
        reportError(err, 'export', {
          clips: clips.length,
          clipMimeTypes: clips.map((clip) => clip.mimeType),
          clipSizes: clips.map((clip) => clip.blob.size),
          mediaErrorCode:
            err instanceof MediaElementFailureError ? err.mediaErrorCode : undefined,
        })
        if (exportRunRef.current !== runId) return
        setExportState({
          status: 'error',
          progress: 0,
          result: null,
          error: err instanceof Error ? err.message : 'Export failed.',
          notice: null,
          watermarked,
        })
      } finally {
        // The export ended in this session (success or error) — it did not die.
        clearExportMarker()
        wakeLockRef.released = true
        void wakeLockRef.current?.release().catch(() => undefined)
        wakeLockRef.current = null
        // The realtime engine closes the context it used; when WebCodecs
        // handled the export, release the unused tap-unlocked context.
        if (audioContext && audioContext.state !== 'closed') {
          void audioContext.close().catch(() => undefined)
        }
      }
    })()
  }, [clips, data.watermarkRemoved, stopCamera])

  const closeExport = useCallback(() => {
    exportRunRef.current += 1
    setExportState(null)
  }, [])

  const setExportNotice = useCallback((notice: string) => {
    setExportState((current) => (current ? { ...current, notice } : current))
  }, [])

  if (!project || data.error) {
    if (data.error === 'Project not found') {
      return <Navigate to="/" replace />
    }
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

  const exporting = exportState?.status === 'exporting'
  const overlayOpen = playing || exportState !== null || onboardingOpen
  const exportFilename = exportState?.result
    ? projectFilename(project.name, exportState.result.fileExtension)
    : null

  return (
    <div className="screen project-screen">
      {/* While exporting, the screens unmount entirely: the camera is
          released (no dead preview burning battery behind the overlay) and
          the full-screen progress takes over. */}
      {exporting ? null : mode === 'record' ? (
        <RecordScreen
          project={project}
          ensureProjectId={ensureProjectId}
          clips={clips}
          camera={camera}
          storage={data.storage}
          locationTaggingEnabled={data.locationTaggingEnabled}
          interactionLocked={overlayOpen}
          onOpenEditor={() => setMode('editor')}
          onOpenExport={startExport}
          onPlay={() => setPlaying(true)}
          showToast={showToast}
          refresh={refresh}
        />
      ) : (
        <EditorScreen
          project={project}
          clips={clips}
          canUndo={data.canUndo}
          interactionLocked={overlayOpen}
          onOpenCamera={() => setMode('record')}
          onOpenExport={startExport}
          onPlay={() => setPlaying(true)}
          showToast={showToast}
          refresh={refresh}
        />
      )}

      {playing ? <PlaybackOverlay clips={clips} onClose={() => setPlaying(false)} /> : null}

      {exporting ? (
        <ExportOverlay
          projectName={project.name}
          progress={exportState?.progress ?? 0}
          bindPreviewCanvas={bindPreviewCanvas}
        />
      ) : null}

      {exportState && exportState.status !== 'exporting' ? (
        <ExportSheet
          status={exportState.status}
          error={exportState.error}
          notice={exportState.notice}
          watermarked={exportState.watermarked}
          purchased={data.watermarkRemoved}
          busy={exportActionCount > 0}
          onRemoveWatermark={() => {
            window.open(REMOVE_WATERMARK_LINK, '_blank', 'noopener')
          }}
          onRestorePurchase={() => setRestoring(true)}
          canShare={
            !!exportState.result &&
            !!exportFilename &&
            canShareFile(exportState.result.blob, exportFilename)
          }
          fileExtension={exportState.result?.fileExtension ?? null}
          fileSizeBytes={exportState.result?.blob.size ?? null}
          onShare={() => {
            const result = exportState.result
            if (!result || !exportFilename) return
            beginExportAction()
            void shareFile(result.blob, exportFilename)
              .then((outcome) => {
                // A cancel (AbortError → 'cancelled') is a routine user action,
                // not something worth announcing — only confirm real shares.
                if (outcome === 'shared') setExportNotice('Shared!')
              })
              .catch(() => {
                setExportNotice('Sharing failed — try Save instead.')
              })
              .finally(endExportAction)
          }}
          onSave={() => {
            const result = exportState.result
            if (!result || !exportFilename) return
            beginExportAction()
            void downloadBlob(result.blob, exportFilename)
              .then(() => {
                setExportNotice('Saved — check your downloads.')
              })
              .catch(() => {
                setExportNotice('Saving failed — try again.')
              })
              .finally(endExportAction)
          }}
          onSaveClips={() => {
            beginExportAction()
            void downloadClipsAsSeparateFiles(clips, project.name)
              .then(() => {
                setExportNotice('Saving original clips — allow multiple downloads if asked.')
              })
              .catch(() => {
                setExportNotice('Saving failed — try again.')
              })
              .finally(endExportAction)
          }}
          onRetry={startExport}
          onClose={closeExport}
        />
      ) : null}

      {restoring ? (
        <RestoreSheet
          onClose={() => setRestoring(false)}
          onRestored={() => {
            setRestoring(false)
            showToast('Purchase restored — new exports are watermark-free')
            refresh()
          }}
        />
      ) : null}

      {onboardingOpen ? (
        <OnboardingOverlay
          onDismiss={() => {
            void (async () => {
              await setOnboardingDismissed(true)
              setOnboardingOpen(false)
            })()
          }}
        />
      ) : null}

      {toast ? (
        <div className="toast">
          <span>{toast.message}</span>
          {toast.actionLabel && toast.onAction ? (
            <button
              type="button"
              onClick={() => {
                window.clearTimeout(toastTimerRef.current)
                setToast(null)
                toast.onAction?.()
              }}
            >
              {toast.actionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
