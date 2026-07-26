import { startTransition, useCallback, useRef, useState } from 'react'
import {
  Link,
  Navigate,
  useLoaderData,
  useRevalidator,
  type LoaderFunctionArgs,
} from 'react-router-dom'
import { EditorScreen } from '../components/editor-screen'
import { ExportSheet, type ExportStatus } from '../components/export-sheet'
import { OnboardingOverlay } from '../components/onboarding-overlay'
import { PlaybackOverlay } from '../components/playback-overlay'
import { RecordScreen, type ToastAction } from '../components/record-screen'
import { useCamera } from '../hooks/use-camera'
import { exportProject, type ExportResult } from '../lib/export'
import {
  canShareFile,
  downloadBlob,
  downloadClipsAsSeparateFiles,
  projectFilename,
  shareFile,
} from '../lib/media'
import { loadProjectPage, type ProjectLoaderData } from '../lib/project-actions'
import { setOnboardingDismissed } from '../lib/storage'

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
}

export async function projectLoader({ params }: LoaderFunctionArgs): Promise<ProjectLoaderData> {
  const projectId = params.projectId
  if (!projectId) {
    return {
      project: null,
      clips: [],
      canUndo: false,
      onboardingDismissed: true,
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

  const [mode, setMode] = useState<ProjectMode>('record')
  const [onboardingOpen, setOnboardingOpen] = useState(() => !data.onboardingDismissed)
  const [playing, setPlaying] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [exportState, setExportState] = useState<ExportUiState | null>(null)

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

    setExportState({ status: 'exporting', progress: 0, result: null, error: null, notice: null })
    void (async () => {
      try {
        const result = await exportProject(clips, {
          audioContext,
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
        setExportState({ status: 'ready', progress: 1, result, error: null, notice: null })
      } catch (err) {
        if (exportRunRef.current !== runId) return
        setExportState({
          status: 'error',
          progress: 0,
          result: null,
          error: err instanceof Error ? err.message : 'Export failed.',
          notice: null,
        })
      } finally {
        // The realtime engine closes the context it used; when WebCodecs
        // handled the export, release the unused tap-unlocked context.
        if (audioContext && audioContext.state !== 'closed') {
          void audioContext.close().catch(() => undefined)
        }
      }
    })()
  }, [clips])

  const closeExport = useCallback(() => {
    exportRunRef.current += 1
    setExportState(null)
  }, [])

  const setExportNotice = useCallback((notice: string) => {
    setExportState((current) => (current ? { ...current, notice } : current))
  }, [])

  if (!data.project || data.error) {
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

  const project = data.project
  const overlayOpen = playing || exportState !== null || onboardingOpen
  const exportFilename = exportState?.result
    ? projectFilename(project.name, exportState.result.fileExtension)
    : null

  return (
    <div className="screen project-screen">
      {mode === 'record' ? (
        <RecordScreen
          project={project}
          clips={clips}
          camera={camera}
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
          onOpenCamera={() => setMode('record')}
          onOpenExport={startExport}
          onPlay={() => setPlaying(true)}
          showToast={showToast}
          refresh={refresh}
        />
      )}

      {playing ? <PlaybackOverlay clips={clips} onClose={() => setPlaying(false)} /> : null}

      {exportState ? (
        <ExportSheet
          projectName={project.name}
          status={exportState.status}
          progress={exportState.progress}
          error={exportState.error}
          notice={exportState.notice}
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
            void shareFile(result.blob, exportFilename)
              .then((outcome) => {
                setExportNotice(outcome === 'shared' ? 'Shared!' : 'Share canceled.')
              })
              .catch(() => {
                setExportNotice('Sharing failed — try Save instead.')
              })
          }}
          onSave={() => {
            const result = exportState.result
            if (!result || !exportFilename) return
            void downloadBlob(result.blob, exportFilename).then(() => {
              setExportNotice('Saved — check your downloads.')
            })
          }}
          onSaveClips={() => {
            void downloadClipsAsSeparateFiles(clips, project.name).then(() => {
              setExportNotice('Saving original clips — allow multiple downloads if asked.')
            })
          }}
          onRetry={startExport}
          onClose={closeExport}
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
