import { startTransition, useCallback, useRef, useState } from 'react'
import {
  Link,
  useLoaderData,
  useNavigate,
  useParams,
  useRevalidator,
  type LoaderFunctionArgs,
} from 'react-router-dom'
import { BlobVideo } from '../components/blob-video'
import { EditorToolsSheet } from '../components/editor-tools-sheet'
import { ExportSheet } from '../components/export-sheet'
import { OnboardingOverlay } from '../components/onboarding-overlay'
import { PlaybackOverlay } from '../components/playback-overlay'
import { Timeline } from '../components/timeline'
import { ToolsSheet } from '../components/tools-sheet'
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
  shareClipFile,
  shareOrDownload,
} from '../lib/media'
import { HoldRecorder } from '../lib/recorder'
import { setOnboardingDismissed } from '../lib/storage'
import { effectiveDurationMs, formatDuration, type ClipId } from '../lib/types'

type Sheet = 'none' | 'trim' | 'export' | 'tools' | 'editor-tools'
type ProjectMode = 'record' | 'editor'
type RecordingMode = 'hold' | 'hands-free'

interface ToastState {
  message: string
  actionLabel?: string
  onAction?: () => void
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
  const { projectId } = useParams()
  const navigate = useNavigate()
  const data = useLoaderData() as ProjectLoaderData
  const revalidator = useRevalidator()
  const camera = useCamera()

  const recorderRef = useRef(new HoldRecorder())
  const pointerIdRef = useRef<number | null>(null)
  const recordRafRef = useRef(0)
  const toastTimerRef = useRef(0)
  const countdownTimerRef = useRef(0)

  const [selectedClipId, setSelectedClipId] = useState<ClipId | null>(
    () => data.clips.at(-1)?.id ?? null,
  )
  const [mode, setMode] = useState<ProjectMode>('record')
  const [onboardingOpen, setOnboardingOpen] = useState(() => !data.onboardingDismissed)
  const [recording, setRecording] = useState(false)
  const [recordingMode, setRecordingMode] = useState<RecordingMode | null>(null)
  const [recordMs, setRecordMs] = useState(0)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [sheet, setSheet] = useState<Sheet>('none')
  const [playing, setPlaying] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [exportProgress, setExportProgress] = useState<number | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [exportMessageTone, setExportMessageTone] = useState<'info' | 'error'>('info')

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

  const showToast = useCallback((message: string, action?: Omit<ToastState, 'message'>) => {
    window.clearTimeout(toastTimerRef.current)
    setToast({ message, ...action })
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2200)
  }, [])

  const clearCountdown = useCallback(() => {
    window.clearTimeout(countdownTimerRef.current)
    countdownTimerRef.current = 0
    setCountdown(null)
  }, [])

  const stopRecordTicker = useCallback(() => {
    cancelAnimationFrame(recordRafRef.current)
    recordRafRef.current = 0
  }, [])

  const attachCameraVideo = camera.videoRef
  const bindCameraVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      if (!element) {
        clearCountdown()
        stopRecordTicker()
        recorderRef.current.cancel()
        window.clearTimeout(toastTimerRef.current)
      }
      attachCameraVideo(element)
    },
    [attachCameraVideo, clearCountdown, stopRecordTicker],
  )

  const beginRecord = useCallback(
    async (pointerId: number | null, nextRecordingMode: RecordingMode) => {
      if (recording || playing || sheet !== 'none' || countdown !== null) return
      if (!camera.stream || !camera.isReady) {
        showToast('Camera not ready')
        return
      }
      pointerIdRef.current = pointerId
      try {
        // Grab the mic only for this take so Brave/Android voice-to-text stays free while idle.
        await camera.enableMic()
        if (pointerId !== null && pointerIdRef.current !== pointerId) {
          camera.releaseMic()
          return
        }
        if (nextRecordingMode === 'hold' && pointerId !== null && pointerIdRef.current === null) {
          camera.releaseMic()
          return
        }
        const startedOk = recorderRef.current.start(camera.stream)
        if (!startedOk) {
          pointerIdRef.current = null
          camera.releaseMic()
          showToast('Still finishing the last clip')
          return
        }
        setRecording(true)
        setRecordingMode(nextRecordingMode)
        setRecordMs(0)
        const started = performance.now()
        const tick = () => {
          setRecordMs(performance.now() - started)
          recordRafRef.current = requestAnimationFrame(tick)
        }
        recordRafRef.current = requestAnimationFrame(tick)
      } catch (err) {
        camera.releaseMic()
        showToast(err instanceof Error ? err.message : 'Could not start recording')
        pointerIdRef.current = null
        setRecordingMode(null)
      }
    },
    [
      camera.enableMic,
      camera.isReady,
      camera.releaseMic,
      camera.stream,
      countdown,
      playing,
      recording,
      sheet,
      showToast,
    ],
  )

  const endRecord = useCallback(
    async (pointerId?: number) => {
      if (
        pointerId !== undefined &&
        pointerIdRef.current !== null &&
        pointerIdRef.current !== pointerId
      ) {
        return
      }
      if (!recorderRef.current.isRecording && !recording) {
        // Pointer released while mic grant was still in flight.
        pointerIdRef.current = null
        camera.releaseMic()
        return
      }
      pointerIdRef.current = null
      stopRecordTicker()
      setRecording(false)
      setRecordingMode(null)
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
        if (mode === 'record') {
          showToast('Clip added')
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Save failed')
      } finally {
        camera.releaseMic()
      }
    },
    [camera.releaseMic, mode, projectId, recording, refresh, showToast, stopRecordTicker],
  )

  const startSelfTimer = useCallback(() => {
    if (recording || playing || sheet !== 'none' || countdown !== null) return
    if (!camera.stream || !camera.isReady) {
      showToast('Camera not ready')
      return
    }

    let next = 3
    setCountdown(next)
    const tick = () => {
      next -= 1
      if (next <= 0) {
        countdownTimerRef.current = 0
        setCountdown(null)
        beginRecord(null, 'hands-free')
        showToast('Hands-free recording. Tap preview to stop.')
        return
      }
      setCountdown(next)
      countdownTimerRef.current = window.setTimeout(tick, 1000)
    }
    countdownTimerRef.current = window.setTimeout(tick, 1000)
  }, [
    beginRecord,
    camera.isReady,
    camera.stream,
    countdown,
    playing,
    recording,
    sheet,
    showToast,
  ])

  const deleteLastClip = useCallback(() => {
    const lastClip = data.clips.at(-1)
    if (!lastClip) {
      showToast('No clips yet')
      return
    }
    void (async () => {
      await removeClip(lastClip.id)
      setSelectedClipId(data.clips.at(-2)?.id ?? null)
      refresh()
      showToast('Last clip deleted', {
        actionLabel: 'Undo',
        onAction: () => {
          void (async () => {
            if (!projectId) return
            const restored = await undoLastDelete(projectId)
            if (restored) setSelectedClipId(restored.id)
            refresh()
            showToast('Clip restored')
          })()
        },
      })
    })()
  }, [data.clips, projectId, refresh, showToast])

  const needsPermission =
    camera.permission.status === 'denied' ||
    camera.permission.status === 'unsupported' ||
    (!!camera.error && !camera.isReady)

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

  return (
    <div className={`screen camera-screen ${mode}-mode${recording ? ' is-recording' : ''}`}>
      <div className="camera-top">
        <Link
          to="/"
          className="btn-icon"
          aria-label="Back to projects"
          onClick={() => {
            clearCountdown()
            stopRecordTicker()
            recorderRef.current.cancel()
            camera.releaseMic()
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
          if (mode !== 'record') return
          if (event.button !== 0) return
          if (countdown !== null) {
            clearCountdown()
            showToast('Timer canceled')
            return
          }
          if (recording && recordingMode === 'hands-free') {
            void endRecord()
            return
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          beginRecord(event.pointerId, 'hold')
        }}
        onPointerUp={(event) => {
          if (mode !== 'record') return
          if (recordingMode !== 'hands-free') {
            void endRecord(event.pointerId)
          }
        }}
        onPointerCancel={(event) => {
          if (mode !== 'record') return
          if (recordingMode !== 'hands-free') {
            void endRecord(event.pointerId)
          }
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        {mode === 'record' ? (
          <video
            ref={bindCameraVideo}
            className={`camera-video${camera.facing === 'user' ? ' mirror' : ''}`}
            muted
            playsInline
            autoPlay
          />
        ) : selected ? (
          <BlobVideo
            key={selected.id}
            blob={selected.blob}
            className="editor-clip-preview"
            muted
            playsInline
            preload="metadata"
            onLoadedData={(event) => {
              const video = event.currentTarget
              video.currentTime = selected.trimStartMs / 1000
            }}
          />
        ) : (
          <div className="editor-empty-preview">Select a clip in the timeline</div>
        )}

        {recording ? (
          <div className="record-overlay">
            <div className="record-pill" aria-live="polite">
              <span className="record-dot" />
              {recordingMode === 'hands-free' ? 'TAP TO STOP' : 'REC'} {formatDuration(recordMs)}
            </div>
          </div>
        ) : null}

        {countdown !== null ? (
          <div className="countdown-overlay" aria-live="assertive">
            {countdown}
          </div>
        ) : null}

        {!recording && countdown === null && mode === 'record' && camera.isReady ? (
          <div className="hold-hint">
            <strong>Hold anywhere</strong>
            <span>release to append</span>
          </div>
        ) : null}

        {mode === 'record' && needsPermission ? (
          <div className="permission-panel">
            <div>
              <h2>Camera access</h2>
              <p>
                {camera.error ??
                  camera.permission.message ??
                  'Allow camera to preview. Microphone is requested only while you record.'}
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
        {mode === 'record' ? (
          <div className="record-dock">
            <div className="record-summary">
              <strong>
                {data.clips.length} clip{data.clips.length === 1 ? '' : 's'}
              </strong>
              <span>{formatDuration(totalDurationMs)} total</span>
            </div>
            <div className="record-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={recording}
                onClick={() => setSheet('tools')}
              >
                Tools
              </button>
              <button
                type="button"
                className="ok-button"
                disabled={data.clips.length === 0 || recording}
                onClick={() => {
                  setExportMessage(null)
                  setExportProgress(null)
                  setSheet('export')
                }}
              >
                OK
              </button>
            </div>
          </div>
        ) : (
          <div className="editor-panel">
            <div className="editor-header">
              <div>
                <p className="eyebrow">Editor</p>
                <strong>{selected ? `Clip ${data.clips.findIndex((c) => c.id === selected.id) + 1}` : 'No clip selected'}</strong>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  camera.releaseMic()
                  setMode('record')
                }}
              >
                Camera
              </button>
            </div>

            <Timeline
              clips={data.clips}
              selectedClipId={resolvedSelectedId}
              onSelect={setSelectedClipId}
            />

            <div className="editor-actions">
              <button
                type="button"
                className="btn btn-primary trim-action"
                disabled={!selected || recording}
                onClick={() => setSheet('trim')}
              >
                Trim
              </button>
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
                    showToast('Clip deleted', {
                      actionLabel: 'Undo',
                      onAction: () => {
                        void (async () => {
                          const restored = await undoLastDelete(projectId)
                          if (restored) setSelectedClipId(restored.id)
                          refresh()
                          showToast('Clip restored')
                        })()
                      },
                    })
                  })()
                }}
              >
                Delete
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={recording}
                onClick={() => setSheet('editor-tools')}
              >
                More
              </button>
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
                className="ok-button compact"
                disabled={data.clips.length === 0 || recording}
                onClick={() => {
                  setExportMessage(null)
                  setExportProgress(null)
                  setSheet('export')
                }}
              >
                OK
              </button>
            </div>
          </div>
        )}
      </div>

      {sheet === 'tools' ? (
        <ToolsSheet
          canDeleteLast={data.clips.length > 0}
          canFlip={camera.canFlip}
          recording={recording}
          countdownActive={countdown !== null}
          onEditor={() => {
            camera.releaseMic()
            setMode('editor')
          }}
          onTimer={startSelfTimer}
          onDeleteLast={deleteLastClip}
          onFlip={() => void camera.flip()}
          onClose={() => setSheet('none')}
        />
      ) : null}

      {sheet === 'editor-tools' ? (
        <EditorToolsSheet
          canAct={!!resolvedSelectedId && !recording}
          canUndo={data.canUndo && !recording}
          onDuplicate={() => {
            void (async () => {
              if (!resolvedSelectedId) return
              const copy = await duplicateSelectedClip(resolvedSelectedId)
              setSelectedClipId(copy.id)
              refresh()
            })()
          }}
          onMoveLeft={() => {
            void (async () => {
              if (!resolvedSelectedId) return
              await moveSelectedClip(projectId, resolvedSelectedId, 'left')
              refresh()
            })()
          }}
          onMoveRight={() => {
            void (async () => {
              if (!resolvedSelectedId) return
              await moveSelectedClip(projectId, resolvedSelectedId, 'right')
              refresh()
            })()
          }}
          onUndo={() => {
            void (async () => {
              const restored = await undoLastDelete(projectId)
              if (restored) setSelectedClipId(restored.id)
              refresh()
              showToast('Clip restored')
            })()
          }}
          onClose={() => setSheet('none')}
        />
      ) : null}

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
          messageTone={exportMessageTone}
          onClose={() => {
            if (!exportBusy) setSheet('none')
          }}
          onDownloadClips={() => {
            void (async () => {
              setExportBusy(true)
              setExportMessageTone('info')
              try {
                // Prefer sharing the latest clip on mobile; also kick off individual downloads.
                const last = data.clips.at(-1)
                if (last) {
                  const mode = await shareClipFile(
                    last,
                    data.project!.name,
                    data.clips.length - 1,
                  )
                  if (mode === 'cancelled') {
                    setExportMessage('Share canceled.')
                  } else if (data.clips.length === 1) {
                    setExportMessage(
                      mode === 'shared'
                        ? 'Shared the clip from this device.'
                        : 'Opened/saved the clip file.',
                    )
                  } else {
                    downloadClipsAsSeparateFiles(data.clips, data.project!.name)
                    setExportMessage(
                      mode === 'shared'
                        ? 'Shared the latest clip. Also started downloads for all clips.'
                        : 'Started clip file saves (no upload).',
                    )
                  }
                } else {
                  downloadClipsAsSeparateFiles(data.clips, data.project!.name)
                  setExportMessage('Started clip file saves (no upload).')
                }
              } catch (err) {
                setExportMessageTone('error')
                setExportMessage(err instanceof Error ? err.message : 'Could not save clip files')
              } finally {
                setExportBusy(false)
              }
            })()
          }}
          onExport={() => {
            void (async () => {
              setExportBusy(true)
              setExportMessage(null)
              setExportMessageTone('info')
              setExportProgress(0)
              try {
                // Unlock AudioContext from this tap so stitched export can mix clip audio.
                let audioContext: AudioContext | undefined
                try {
                  audioContext = new AudioContext()
                  if (audioContext.state === 'suspended') {
                    await audioContext.resume()
                  }
                } catch {
                  audioContext = undefined
                }
                const blob = await exportProjectAsWebm(data.clips, setExportProgress, {
                  audioContext,
                })
                const filename = projectFilename(data.project!.name)
                const shareMode = await shareOrDownload(blob, filename)
                switch (shareMode) {
                  case 'shared':
                    setExportMessage('Shared the stitched video from this device.')
                    break
                  case 'downloaded':
                    setExportMessage(
                      'Saved/opened the stitched video locally. On Android, use the share sheet if the file did not appear in Downloads.',
                    )
                    break
                  case 'cancelled':
                    setExportMessage('Share canceled — video stayed on this device.')
                    break
                  default: {
                    const _exhaustive: never = shareMode
                    setExportMessage(`Unexpected share result: ${_exhaustive}`)
                  }
                }
              } catch (err) {
                setExportMessageTone('error')
                setExportMessage(
                  err instanceof Error
                    ? `${err.message} Tap Files to save original clips instead.`
                    : 'Export failed. Tap Files to save original clips instead.',
                )
              } finally {
                setExportBusy(false)
                setExportProgress(null)
              }
            })()
          }}
        />
      ) : null}

      {onboardingOpen ? (
        <OnboardingOverlay
          onDismiss={() => {
            void (async () => {
              await setOnboardingDismissed(true)
              setOnboardingOpen(false)
              refresh()
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
