import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import { EditorScreen } from '../components/editor-screen'
import { ExportOverlay } from '../components/export-overlay'
import { ExportSheet, type ExportStatus } from '../components/export-sheet'
import { OnboardingOverlay } from '../components/onboarding-overlay'
import { PlaybackOverlay } from '../components/playback-overlay'
import { RecordScreen, type ToastAction } from '../components/record-screen'
import { createCamera } from '../lib/camera'
import { RestoreSheet } from '../components/restore-sheet'
import { UpsellSheet } from '../components/upsell-sheet'
import { REMOVE_WATERMARK_LINK } from '../lib/entitlement'
import { buildClipsZip } from '../lib/clips-zip'
import { clearExportMarker, markExportStarted, reportError } from '../lib/error-reporting'
import { exportProject, type ExportResult } from '../lib/export'
import { exportSignature, loadMatchingExport, persistLastExport } from '../lib/export/last-export'
import { MediaElementFailureError } from '../lib/export/media-error'
import { wait } from '../lib/export/shared'
import {
  canShareFile,
  downloadBlob,
  isIosBrowser,
  projectFilename,
  shareFile,
} from '../lib/media'
import { loadProjectPage, type ProjectLoaderData } from '../lib/project-actions'
import { createProject, setOnboardingDismissed } from '../lib/storage'
import { requestPersistentStorage } from '../lib/storage-space'
import { navigate } from '../router'
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

interface ProjectPageProps {
  projectId: string
}

export function ProjectPage(handle: Handle<ProjectPageProps>) {
  const { props } = handle
  const camera = createCamera(() => void handle.update())

  let data: ProjectLoaderData | null = null
  /** The projectId the current `data` was loaded for — reloads when the URL
   * param changes in place (e.g. /project/new → /project/<id> after the
   * first clip persists the lazy project; the page instance survives so the
   * camera never restarts). */
  let loadedForId: string | null = null

  let toastTimer = 0
  let exportRun = 0
  let previewCanvas: HTMLCanvasElement | null = null
  const bindPreviewCanvas = (element: HTMLCanvasElement | null) => {
    previewCanvas = element
  }

  let mode: ProjectMode = 'record'
  let onboardingOpen = false
  let onboardingInitialized = false
  let playing = false
  let toast: ToastState | null = null
  let exportState: ExportUiState | null = null
  let restoring = false
  let upselling = false
  /** In-flight share/save COUNT (concurrent actions must not clear each
   * other's busy state) — the export sheet must not dismiss while > 0. */
  let exportActionCount = 0
  const beginExportAction = () => {
    exportActionCount += 1
    void handle.update()
  }
  const endExportAction = () => {
    exportActionCount = Math.max(0, exportActionCount - 1)
    void handle.update()
  }

  /** Monotonic request id: an older in-flight load for the same project
   * (mount racing a post-mutation refresh) must never overwrite newer data. */
  let loadVersion = 0
  const load = (projectId: string) => {
    loadedForId = projectId
    const version = ++loadVersion
    void loadProjectPage(projectId)
      .then((loaded) => {
        if (handle.signal.aborted || version !== loadVersion) return
        data = loaded
        if (!onboardingInitialized) {
          onboardingInitialized = true
          onboardingOpen = !loaded.onboardingDismissed
        }
        void handle.update()
      })
      .catch((err) => {
        if (handle.signal.aborted || version !== loadVersion) return
        reportError(err, 'load-project')
        // Reuse the page's error rendering path (banner + back-home link).
        data = {
          project: null,
          clips: [],
          audio: null,
          canUndo: false,
          onboardingDismissed: true,
          watermarkRemoved: false,
          storage: null,
          locationTaggingEnabled: false,
          error: err instanceof Error ? err.message : 'Could not load this project.',
        }
        void handle.update()
      })
  }
  load(props.projectId)

  /** The URL is the authority on which project this page shows. Right after
   * lazy creation, `navigate(replace)` has already rewritten the path while
   * `props.projectId` only catches up on the router's next render — a
   * mutation's immediate refresh must follow the URL, never a stale id. */
  const currentProjectId = () => {
    const match = window.location.pathname.match(/^\/project\/([^/]+)/)
    return match?.[1] ?? props.projectId
  }

  const refresh = () => {
    load(currentProjectId())
  }

  const showToast = (message: string, action?: ToastAction) => {
    window.clearTimeout(toastTimer)
    toast = { message, ...action }
    void handle.update()
    toastTimer = window.setTimeout(() => {
      toast = null
      void handle.update()
    }, 2600)
  }

  // Lazy creation: a "/project/new" project is persisted only when the
  // first clip finishes recording. The promise is memoized so overlapping
  // takes (or a camera take racing a screen take) create exactly one.
  let ensureProjectPromise: Promise<ProjectId> | null = null
  /** Set once the lazy project persists: data loaded for 'new' may keep
   * rendering under the created id (same logical project — the camera must
   * not unmount mid-flow while the reload is in flight). */
  let createdProjectId: ProjectId | null = null
  const ensureProjectId = (): Promise<ProjectId> => {
    const project = data?.project
    if (project && project.id !== NEW_PROJECT_ID) return Promise.resolve(project.id)
    ensureProjectPromise ??= (async () => {
      try {
        const created = await createProject()
        createdProjectId = created.id
        // Their recordings should survive storage pressure.
        requestPersistentStorage()
        navigate(`/project/${created.id}`, { replace: true })
        return created.id
      } catch (err) {
        // A failed creation must not poison later attempts.
        ensureProjectPromise = null
        throw err
      }
    })()
    return ensureProjectPromise
  }

  const setExportState = (next: ExportUiState | null) => {
    exportState = next
    void handle.update()
  }

  const startExport = (options?: { force?: boolean }) => {
    if (!data) return
    const clips = data.clips
    const project = data.project
    const audio = data.audio
    if (clips.length === 0) return
    const runId = exportRun + 1
    exportRun = runId

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
    const signature = exportSignature(clips, watermarked, audio)
    // Stop camera/mic immediately rather than waiting on record-screen
    // unmount. On iOS the combined mic+camera session can hold decoder
    // slots past the first paints, and WebKit reports that race as
    // MEDIA_ERR_SRC_NOT_SUPPORTED for an otherwise playable clip.
    camera.stop()
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
    const wakeLockState: { current: WakeLockSentinel | null; released: boolean } = {
      current: null,
      released: false,
    }
    void navigator.wakeLock
      ?.request('screen')
      .then((sentinel) => {
        if (wakeLockState.released) {
          // The export finished before the request resolved — never leak.
          void sentinel.release().catch(() => undefined)
          return
        }
        wakeLockState.current = sentinel
      })
      .catch(() => undefined)

    void (async () => {
      try {
        // Unchanged project + a persisted last export = instant "ready":
        // missing the share sheet must never cost a re-encode. Retry
        // bypasses this (force) and always renders fresh.
        if (!options?.force && project) {
          const recovered = await loadMatchingExport(project.id, signature).catch(() => null)
          if (exportRun !== runId) return
          if (recovered) {
            setExportState({
              status: 'ready',
              progress: 1,
              result: recovered.result,
              error: null,
              notice: 'Restored your last export — nothing changed since. Retry re-renders.',
              watermarked: recovered.watermarked,
            })
            return
          }
        }

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
        if (exportRun !== runId) return

        // If the page dies mid-export (tab crash / OOM — no JS error fires),
        // this marker survives the reload and reports the death at next boot.
        markExportStarted({ clips: clips.length })
        const result = await exportProject(clips, {
          audioContext,
          watermark: watermarked,
          background: audio
            ? { blob: audio.blob, defaultVolume: audio.defaultVolume }
            : undefined,
          getPreviewCanvas: () => previewCanvas,
          onProgress: (ratio) => {
            if (exportRun !== runId) return
            if (exportState && exportState.status === 'exporting') {
              exportState = { ...exportState, progress: ratio }
              void handle.update()
            }
          },
        })
        // Persist for recovery/instant reuse — in the background, the sheet
        // must not wait on a disk copy of a possibly huge file.
        if (project) {
          void persistLastExport({
            projectId: project.id,
            result,
            signature,
            watermarked,
          }).catch(() => undefined)
        }
        if (exportRun !== runId) return
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
          // Which engine, which clip, which load purpose — attached at the
          // failing callsite (KODY-VIDEO-A was undebuggable without it).
          exportDetail:
            err && typeof err === 'object'
              ? (err as { exportDetail?: Record<string, unknown> }).exportDetail
              : undefined,
        })
        if (exportRun !== runId) return
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
        wakeLockState.released = true
        void wakeLockState.current?.release().catch(() => undefined)
        wakeLockState.current = null
        // The realtime engine closes the context it used; when WebCodecs
        // handled the export, release the unused tap-unlocked context.
        if (audioContext && audioContext.state !== 'closed') {
          void audioContext.close().catch(() => undefined)
        }
      }
    })()
  }

  const closeExport = () => {
    exportRun += 1
    setExportState(null)
  }

  const setExportNotice = (notice: string) => {
    if (exportState) {
      exportState = { ...exportState, notice }
      void handle.update()
    }
  }

  return () => {
    // The URL param changed in place (lazy create, or another project link).
    if (props.projectId !== loadedForId) {
      load(props.projectId)
    }
    if (!data) return null
    const project = data.project
    const clips = data.clips

    if (!project || data.error) {
      if (data.error === 'Project not found') {
        handle.queueTask(() => navigate('/', { replace: true }))
        return null
      }
      return (
        <div className="screen">
          <div className="error-banner">{data.error ?? 'Project missing'}</div>
          <div style={{ marginTop: '16px' }}>
            <a className="btn btn-secondary" href="/">
              Back home
            </a>
          </div>
        </div>
      )
    }

    // The rendered data must belong to the current route: browser history
    // between two projects changes the param in place, and the previous
    // project's clips must not stay visible (or actionable) while the new
    // load is in flight. The lazy-create transition ('new' → the freshly
    // created id) is the same logical project and keeps rendering, so the
    // camera never unmounts mid-flow.
    const isLazyCreateAlias =
      project.id === NEW_PROJECT_ID &&
      (props.projectId === NEW_PROJECT_ID || props.projectId === createdProjectId)
    if (project.id !== props.projectId && !isLazyCreateAlias) return null

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
            onOpenEditor={() => {
              mode = 'editor'
              void handle.update()
            }}
            onOpenExport={() => startExport()}
            onPlay={() => {
              playing = true
              void handle.update()
            }}
            showToast={showToast}
            refresh={refresh}
          />
        ) : (
          <EditorScreen
            project={project}
            ensureProjectId={ensureProjectId}
            clips={clips}
            audio={data.audio}
            plus={data.watermarkRemoved}
            onUpsell={() => {
              upselling = true
              void handle.update()
            }}
            canUndo={data.canUndo}
            interactionLocked={overlayOpen}
            onOpenCamera={() => {
              mode = 'record'
              void handle.update()
            }}
            onOpenExport={() => startExport()}
            onPlay={() => {
              playing = true
              void handle.update()
            }}
            showToast={showToast}
            refresh={refresh}
          />
        )}

        {playing ? (
          <PlaybackOverlay
            clips={clips}
            audio={data.audio}
            onClose={() => {
              playing = false
              void handle.update()
            }}
          />
        ) : null}

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
            onRestorePurchase={() => {
              restoring = true
              void handle.update()
            }}
            canShare={
              !!exportState.result &&
              !!exportFilename &&
              canShareFile(exportState.result.blob, exportFilename)
            }
            fileExtension={exportState.result?.fileExtension ?? null}
            fileSizeBytes={exportState.result?.blob.size ?? null}
            onShare={() => {
              const result = exportState?.result
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
              const result = exportState?.result
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
              setExportNotice(
                `Zipping ${clips.length} clip${clips.length === 1 ? '' : 's'}… keep this open.`,
              )
              void buildClipsZip(clips)
                .then((zip) => downloadBlob(zip, projectFilename(`${project.name} clips`, 'zip')))
                .then(() => {
                  setExportNotice('Clips zipped — check your downloads.')
                })
                .catch(() => {
                  setExportNotice('Zipping failed — try again.')
                })
                .finally(endExportAction)
            }}
            onRetry={() => startExport({ force: true })}
            onReExport={() => startExport({ force: true })}
            onClose={closeExport}
          />
        ) : null}

        {upselling ? (
          <UpsellSheet
            onClose={() => {
              upselling = false
              void handle.update()
            }}
            onRestore={() => {
              upselling = false
              restoring = true
              void handle.update()
            }}
          />
        ) : null}

        {restoring ? (
          <RestoreSheet
            onClose={() => {
              restoring = false
              void handle.update()
            }}
            onRestored={() => {
              restoring = false
              void handle.update()
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
                onboardingOpen = false
                void handle.update()
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
                mix={on('click', () => {
                  window.clearTimeout(toastTimer)
                  const action = toast?.onAction
                  toast = null
                  void handle.update()
                  action?.()
                })}
              >
                {toast.actionLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }
}
