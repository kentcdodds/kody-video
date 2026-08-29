import type { Handle } from 'remix/ui'
import { on } from 'remix/ui'
import { IconBack } from '../components/icons'
import { BrandMark } from '../components/brand-mark'
import { RestoreSheet } from '../components/restore-sheet'
import { SharePlusSheet } from '../components/share-plus-sheet'
import { UpsellSheet } from '../components/upsell-sheet'
import { VideoQualityPicker } from '../components/video-quality-picker'
import {
  checkForUpdates,
  fetchDeployedVersion,
  getUpdateDiagnostics,
  isRunningStale,
  reconcileUpdateCheckResult,
  type UpdateDiagEvent,
} from '../lib/app-update'
import { buildDateLabel, COMMIT_SHA, commitUrl, shortVersion } from '../lib/build-info'
import { reportError } from '../lib/error-reporting'
import { clearExportCache, estimateExportCacheBytes } from '../lib/export/export-cache'
import { listRearCameras } from '../lib/media'
import { BackupFormatError, importKodyVideoBackupFile } from '../lib/project-transfer'
import { estimateStorageSpace, formatBytes, type StorageSpace } from '../lib/storage-space'
import { getSettings, setVideoQuality } from '../lib/storage'
import { resolveVideoQuality, type VideoQualityPreset } from '../lib/video-quality'
import { navigate } from '../router'

/** Prefilled GitHub issue so bug reports arrive with device context attached. */
function reportProblemUrl(): string {
  const body = [
    '## What happened?',
    '',
    '(describe the problem — what you tapped, what you expected, what you got)',
    '',
    '## Device info (auto-filled)',
    '',
    `- App URL: ${location.origin}`,
    `- User agent: ${navigator.userAgent}`,
    `- Screen: ${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}x`,
    `- Installed as app: ${window.matchMedia('(display-mode: standalone)').matches ? 'yes' : 'no'}`,
  ].join('\n')
  const params = new URLSearchParams({ labels: 'bug', body })
  return `https://github.com/kentcdodds/kody-video/issues/new?${params}`
}

function shortSha(sha: string | null): string {
  if (!sha) return 'unknown'
  return sha === 'dev' ? 'dev' : sha.slice(0, 7)
}

function formatDiagEvent(event: UpdateDiagEvent): string {
  const time = new Date(event.at).toLocaleTimeString()
  const bits = [time, event.phase]
  if (event.reason) bits.push(event.reason)
  if (event.claimed !== undefined) bits.push(event.claimed ? 'claimed' : 'no-claim')
  return bits.join(' · ')
}

function updateDiagnosticsReport(
  deployedCommit: string | null,
  deployedKnown: boolean,
): string | null {
  const diag = getUpdateDiagnostics()
  const stale = isRunningStale(deployedCommit ? { commit: deployedCommit } : null)
  const activeWorker = diag.waiting || diag.installing
  if (!stale && diag.events.length === 0 && !activeWorker) return null
  if (!deployedKnown && diag.events.length === 0 && !activeWorker) return null
  return [
    `Running: ${shortSha(COMMIT_SHA)}`,
    `Deployed: ${shortSha(deployedCommit)}`,
    `Controller: ${diag.hasController ? 'yes' : 'no'}`,
    `Waiting worker: ${diag.waiting ? 'yes' : 'no'}`,
    `Installing worker: ${diag.installing ? 'yes' : 'no'}`,
    ...diag.events.map(formatDiagEvent),
  ].join('\n')
}

interface AboutData {
  storage: StorageSpace | null
  exportCacheBytes: number
  plus: boolean
  videoQuality: VideoQualityPreset
}

async function loadAboutData(): Promise<AboutData> {
  const [storage, exportCacheBytes, settings] = await Promise.all([
    estimateStorageSpace(),
    estimateExportCacheBytes(),
    getSettings(),
  ])
  return {
    storage,
    exportCacheBytes,
    plus: settings.watermarkRemoved === true,
    videoQuality: resolveVideoQuality(settings.videoQuality, settings.watermarkRemoved === true),
  }
}

type UpdateStatus = 'idle' | 'checking' | 'current' | 'updating' | 'downloading' | 'unavailable'

const UPDATE_STATUS_LABEL: Record<Exclude<UpdateStatus, 'idle'>, string> = {
  checking: 'Checking…',
  current: "You're on the latest version.",
  updating: 'Update found — reloading…',
  downloading: 'Update found — still downloading. It will offer itself when ready.',
  unavailable: "Couldn't check right now (offline, or not running from a deployment).",
}

/** Credits, inspiration, and the open-source pointer. */
export function AboutPage(handle: Handle) {
  let data: AboutData = {
    storage: null,
    exportCacheBytes: 0,
    plus: false,
    videoQuality: 'standard',
  }
  let sharingPlus = false
  let upselling = false
  let restoring = false
  let updateStatus: UpdateStatus = 'idle'
  let cacheStatus: string | null = null
  let clearingCache = false
  let cameraReport: string | null = null
  let inspectingCameras = false
  let importing = false
  let importProgress: string | null = null
  let importError: string | null = null
  let deployedCommit: string | null = null
  let deployedKnown = false

  const refresh = async () => {
    data = await loadAboutData()
    if (handle.signal.aborted) return
    void handle.update()
  }
  void refresh()
  let hashScrolled = false
  void fetchDeployedVersion().then((deployed) => {
    if (handle.signal.aborted) return
    deployedCommit = deployed?.commit ?? null
    deployedKnown = true
    void handle.update()
  })

  /**
   * On-device camera diagnostic: what the browser exposes varies wildly by
   * phone and Chrome build (labels, facingMode capability, zoom ranges),
   * and remote bug reports about lenses are unresolvable without it.
   */
  const onInspectCameras = async () => {
    if (inspectingCameras) return
    inspectingCameras = true
    void handle.update()
    let probe: MediaStream | null = null
    try {
      probe = await navigator.mediaDevices.getUserMedia({ video: true })
      const track = probe.getVideoTracks()[0]
      const caps = track?.getCapabilities?.() as
        | (MediaTrackCapabilities & { zoom?: { min?: number; max?: number } })
        | undefined
      const lines: string[] = [`Active camera: ${track?.label || '(no label)'}`]
      if (caps?.zoom && typeof caps.zoom.min === 'number') {
        lines.push(`Active zoom range: ${caps.zoom.min}–${caps.zoom.max}×`)
      } else {
        lines.push('Active zoom range: not exposed')
      }
      const rear = await listRearCameras()
      lines.push(`Detected rear lenses: ${rear.length}`)
      const devices = await navigator.mediaDevices.enumerateDevices()
      for (const device of devices) {
        if (device.kind !== 'videoinput') continue
        const facing = (
          device as MediaDeviceInfo & { getCapabilities?: () => MediaTrackCapabilities }
        ).getCapabilities?.()?.facingMode
        const facingLabel =
          Array.isArray(facing) && facing.length > 0 ? ` [${facing.join(', ')}]` : ''
        const rearMark = rear.includes(device.deviceId) ? ' — rear' : ''
        lines.push(`• ${device.label || '(no label)'}${facingLabel}${rearMark}`)
      }
      cameraReport = lines.join('\n')
    } catch (err) {
      cameraReport =
        err instanceof Error ? `Could not inspect: ${err.message}` : 'Could not inspect cameras.'
    } finally {
      probe?.getTracks().forEach((track) => {
        track.stop()
      })
      inspectingCameras = false
      void handle.update()
    }
  }

  const onClearExportCache = () => {
    if (clearingCache) return
    clearingCache = true
    void handle.update()
    void clearExportCache()
      .then((freedBytes) => {
        cacheStatus = `Freed ${formatBytes(freedBytes)}.`
        void refresh()
      })
      .catch((err) => {
        reportError(err, 'clear-export-cache')
        cacheStatus =
          err instanceof Error ? err.message : 'Could not clear cached exports — try again.'
      })
      .finally(() => {
        clearingCache = false
        void handle.update()
      })
  }

  const importBackup = (file: File) => {
    void (async () => {
      importing = true
      importError = null
      importProgress = 'Reading backup…'
      void handle.update()
      try {
        const project = await importKodyVideoBackupFile(file, (done, total) => {
          importProgress = `Importing clip ${Math.min(done + 1, total)} of ${total}…`
          void handle.update()
        })
        // Land directly in the imported project — unambiguous success.
        navigate(`/project/${project.id}`)
      } catch (err) {
        // Wrong/damaged file picked = expected user input, not a crash.
        if (!(err instanceof BackupFormatError)) reportError(err, 'import')
        importError = err instanceof Error ? err.message : 'Could not import that file'
      } finally {
        importProgress = null
        importing = false
        void handle.update()
      }
    })()
  }

  const onCheckForUpdates = () => {
    if (updateStatus === 'checking' || updateStatus === 'updating') return
    updateStatus = 'checking'
    void handle.update()
    void checkForUpdates()
      .then((result) => {
        const resolved = reconcileUpdateCheckResult(
          result,
          deployedCommit ? { commit: deployedCommit } : null,
        )
        switch (resolved) {
          case 'updated':
            // checkForUpdates already applied it; the page is about to reload.
            updateStatus = 'updating'
            return
          case 'current':
            updateStatus = 'current'
            return
          case 'downloading':
            updateStatus = 'downloading'
            return
          case 'unavailable':
            updateStatus = 'unavailable'
            return
          default: {
            const exhaustive: never = resolved
            throw new Error(`Unhandled update result: ${String(exhaustive)}`)
          }
        }
      })
      .catch(() => {
        updateStatus = 'unavailable'
      })
      .finally(() => void handle.update())
  }

  return () => {
    const { storage, exportCacheBytes, plus, videoQuality } = data
    if (!hashScrolled && location.hash === '#video-quality') {
      hashScrolled = true
      queueMicrotask(() => {
        document.getElementById('video-quality')?.scrollIntoView({ block: 'start' })
      })
    }
    const version = <code>{shortVersion()}</code>
    const versionUrl = commitUrl()
    const diagReport = updateDiagnosticsReport(deployedCommit, deployedKnown)
    return (
      <div className="screen about-screen">
        <div className="about-top">
          <a href="/" className="btn-icon" aria-label="Back to projects">
            <IconBack />
          </a>
          <strong>About</strong>
          <span className="about-top-spacer" aria-hidden="true" />
        </div>

        <div className="about-body">
          <div className="about-hero" aria-hidden="true">
            <BrandMark size={96} className="brand-hero-art" variant="icon" />
          </div>
          <h1>
            Kody <span>Video</span>
          </h1>

          {plus ? (
            <section className="about-section">
              <h2>Kody Video Plus</h2>
              <p>
                This device is unlocked. To use Plus on a second phone or computer, show a short
                code and QR the new device can type or scan — no Stripe receipt required.
              </p>
              <button
                type="button"
                className="btn btn-ghost"
                mix={on('click', () => {
                  sharingPlus = true
                  void handle.update()
                })}
              >
                Use Plus on another device
              </button>
            </section>
          ) : null}

          <section className="about-section">
            <h2>Free &amp; open source</h2>
            <p>
              Kody Video is open source — the whole app, including the export engine, lives at{' '}
              <a
                href="https://github.com/kentcdodds/kody-video"
                target="_blank"
                rel="noreferrer noopener"
              >
                github.com/kentcdodds/kody-video
              </a>
              . Issues, ideas, and pull requests are welcome.
            </p>
          </section>

          <section className="about-section">
            <h2>See it in action</h2>
            <p>
              Kent demos the whole flow — record, arrange, share — in a minute and a half:{' '}
              <a
                href="https://youtube.com/shorts/JaUdPTHHk7A"
                target="_blank"
                rel="noreferrer noopener"
              >
                watch the tour on YouTube
              </a>
              . The same video plays right on the home screen when you&rsquo;re new here. Want a
              real result straight out of the app? Here&rsquo;s{' '}
              <a
                href="https://x.com/kentcdodds/status/2084891368724533456"
                target="_blank"
                rel="noreferrer noopener"
              >
                a video Kent made with Kody Video
              </a>
              .
            </p>
          </section>

          <section className="about-section">
            <h2>Inspired by OK Video</h2>
            <p>
              This app exists because of{' '}
              <a href="https://okvideo.app" target="_blank" rel="noreferrer noopener">
                OK Video
              </a>{' '}
              by Pim Coumans — a wonderful hold-to-record clips camera for iPhone and a heavy source
              of inspiration for Kody Video&rsquo;s whole interaction model. If you&rsquo;re on iOS,
              go get the real thing. Kody Video is an independent project and is not affiliated with
              OK Video.
            </p>
          </section>

          <section className="about-section">
            <h2>Kody the koala</h2>
            <p>
              The mascot comes from the KCD community —{' '}
              <a href="https://kentcdodds.com/kody" target="_blank" rel="noreferrer noopener">
                kentcdodds.com/kody
              </a>
              .
            </p>
          </section>

          <section className="about-section">
            <h2>Private by design</h2>
            <p>
              No accounts, no uploads, no cross-site tracking. Clips live in this browser&rsquo;s
              storage until you export and share them yourself. The app&rsquo;s only own network
              traffic: Stripe checkout and its purchase verification if you buy the watermark
              removal, anonymous crash reports (error and stack trace only — never your media) when
              something breaks, cookieless page-view counts via Fathom Analytics, the tour video
              streaming from this app&rsquo;s own domain if you tap play on it, and — only if you
              tap Send to device — a short-lived matchmaking room so two browsers can find each
              other, and a short-lived restore code if you share Plus with another device. Clips
              still never upload.
            </p>
          </section>

          <section className="about-section">
            <h2>Made for phones</h2>
            <p>
              Kody Video is designed as a mobile camera app — install it on your phone for the real
              experience. It works on desktop too, with keyboard support: hold <kbd>Space</kbd> to
              record, <kbd>F</kbd> flips the camera, <kbd>T</kbd> starts the self-timer,{' '}
              <kbd>E</kbd> opens the editor, <kbd>P</kbd> plays your cut, and <kbd>Delete</kbd>{' '}
              removes the last clip. In the editor the arrow keys select clips,{' '}
              <kbd>Alt</kbd>+arrows reorder, <kbd>T</kbd> trims, <kbd>D</kbd> duplicates,{' '}
              <kbd>Delete</kbd> deletes, and <kbd>Esc</kbd> goes back. During playback the arrows
              skip clips, <kbd>Space</kbd> pauses, and <kbd>Esc</kbd> closes.
            </p>
          </section>

          <section className="about-section" id="video-quality">
            <h2>Video quality</h2>
            <p>
              New clips only — already-recorded takes stay as they are. Every option stays at 30
              frames a second so recording does not drop frames or get janky. Without Plus, new
              clips record at Standard (720p). High (1080p) is a Kody Video Plus perk.
            </p>
            <VideoQualityPicker
              value={videoQuality}
              plus={plus}
              onUpsell={() => {
                upselling = true
                void handle.update()
              }}
              onChange={(next) => {
                data = { ...data, videoQuality: next }
                void handle.update()
                void setVideoQuality(next).catch((err) => {
                  reportError(err, 'video-quality')
                  void refresh()
                })
              }}
            />
          </section>

          <section className="about-section">
            <h2>Storage</h2>
            <p>
              {storage
                ? `This app uses ${formatBytes(storage.usedBytes)} of the ${formatBytes(storage.quotaBytes)} the browser allows. `
                : ''}
              Your recordings are the big consumer — delete old projects from the home screen
              (⋯ → Delete) to free the most space, or record new clips at a lower video quality
              above. The app also keeps your latest export cached so tapping Go on an unchanged
              project is instant.
            </p>
            <p>
              Cached export files: <strong>{formatBytes(exportCacheBytes)}</strong>
              {exportCacheBytes > 0 ? (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="link-button"
                    disabled={clearingCache}
                    mix={on('click', onClearExportCache)}
                  >
                    Clear
                  </button>
                </>
              ) : null}
            </p>
            {cacheStatus ? (
              <p role="status" aria-live="polite">
                {cacheStatus}
              </p>
            ) : null}
          </section>

          <section className="about-section">
            <h2>Backups</h2>
            <p>
              Every project can be saved as a single <code>.kodyvideo</code> file (⋯ →{' '}
              <strong>Save backup</strong> on the home screen) — a safety net, and the way to move
              a project between devices. Plus can also <strong>Send to device</strong> over the
              local network (the other device opens{' '}
              <a href="/receive">kody.video/receive</a>). Restore a backup here, or drop the file
              anywhere in the app:
            </p>
            <label className={`btn btn-ghost about-import${importing ? ' is-disabled' : ''}`}>
              Import a backup
              <input
                type="file"
                accept=".kodyvideo,application/octet-stream"
                className="visually-hidden"
                disabled={importing}
                mix={on('change', (event) => {
                  const input = event.currentTarget as HTMLInputElement
                  const file = input.files?.[0]
                  input.value = ''
                  if (file) importBackup(file)
                })}
              />
            </label>
            {importProgress ? (
              <p role="status" aria-live="polite">
                {importProgress} Keep this tab open.
              </p>
            ) : null}
            {importError ? <div className="error-banner">{importError}</div> : null}
          </section>

          <section className="about-section">
            <h2>Cameras</h2>
            <p>
              Wondering why a lens or zoom level isn&rsquo;t available? Browsers expose cameras
              very differently across phones —{' '}
              <button
                type="button"
                className="link-button"
                disabled={inspectingCameras}
                mix={on('click', () => void onInspectCameras())}
              >
                {inspectingCameras ? 'Inspecting…' : 'Inspect cameras'}
              </button>{' '}
              shows exactly what this browser reports (nothing is sent anywhere — attach it to a
              bug report if something looks wrong).
            </p>
            {cameraReport ? <pre className="camera-report">{cameraReport}</pre> : null}
          </section>

          <section className="about-section">
            <h2>Support</h2>
            <p>
              Hit a bug? Please{' '}
              <a href={reportProblemUrl()} target="_blank" rel="noreferrer noopener">
                open an issue on GitHub
              </a>{' '}
              — the link pre-fills your device details so you only have to describe what went wrong.
              Prefer email (or need help with a purchase)? Write to{' '}
              <a href="mailto:team@kody.video">team@kody.video</a>.
            </p>
          </section>

          <section className="about-section">
            <h2>Version</h2>
            <p>
              {versionUrl ? (
                <a href={versionUrl} target="_blank" rel="noreferrer noopener">
                  {version}
                </a>
              ) : (
                version
              )}{' '}
              · built {buildDateLabel()}
              {' · '}
              <button
                type="button"
                className="link-button"
                disabled={updateStatus === 'checking' || updateStatus === 'updating'}
                mix={on('click', onCheckForUpdates)}
              >
                Check for updates
              </button>
            </p>
            {updateStatus !== 'idle' ? (
              <p role="status" aria-live="polite">
                {UPDATE_STATUS_LABEL[updateStatus]}
              </p>
            ) : null}
            {deployedKnown && isRunningStale(deployedCommit ? { commit: deployedCommit } : null) ? (
              <p role="status" aria-live="polite">
                This screen is still on an older build than the server. Tap Check for updates.
              </p>
            ) : null}
            {diagReport ? (
              <details className="about-update-diag">
                <summary>Update details</summary>
                <pre className="camera-report">{diagReport}</pre>
              </details>
            ) : null}
          </section>

          <section className="about-section">
            <h2>Legal</h2>
            <p>
              <a href="/privacy">Privacy</a>
              {' · '}
              <a href="/terms">Terms</a>
            </p>
          </section>
        </div>
        {sharingPlus ? (
          <SharePlusSheet
            onClose={() => {
              sharingPlus = false
              void handle.update()
            }}
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
              void refresh()
            }}
          />
        ) : null}
      </div>
    )
  }
}
