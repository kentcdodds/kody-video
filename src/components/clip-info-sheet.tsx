import type { Handle } from 'remix/ui'
import { on, ref } from 'remix/ui'
import { canSplitClip, clipHasUnusedMedia } from '../lib/clip-edit'
import { planClipQualityReduction } from '../lib/clip-quality'
import { buildClipFacts } from '../lib/clip-facts'
import { clipFit, clipMismatchesFilm } from '../lib/clip-fit'
import { attachSheetModal } from '../lib/sheet-modal'
import {
  effectiveDurationMs,
  isImageClip,
  type ClipFit,
  type ClipRecord,
  type ProjectOrientation,
} from '../lib/types'
import { IconCompress, IconCrop, IconDownload, IconLetterbox, IconSplit, IconTrim } from './icons'

interface ClipInfoSheetProps {
  clip: ClipRecord
  clips: ClipRecord[]
  index: number
  projectName: string
  filmOrientation: ProjectOrientation
  onSetFit: (fit: ClipFit) => Promise<void>
  onPermanentlyTrim: () => Promise<void>
  onReduceQuality: () => Promise<void>
  onStartSplit: () => void
  onDownload: () => Promise<void>
  onClose: () => void
}

type BusyAction = 'trim' | 'quality' | 'download' | null
type ConfirmingAction = 'trim' | 'quality' | null

/** Facts + destructive clip edits (permanent trim, split) and download. */
export function ClipInfoSheet(handle: Handle<ClipInfoSheetProps>) {
  let busy: BusyAction = null
  let confirming: ConfirmingAction = null
  let error: string | null = null

  const run = async (action: Exclude<BusyAction, null>, work: () => Promise<void>) => {
    if (busy) return
    busy = action
    error = null
    void handle.update()
    try {
      await work()
      busy = null
      void handle.update()
    } catch (err) {
      error = err instanceof Error ? err.message : 'Something went wrong'
      busy = null
      void handle.update()
    }
  }

  return () => {
    const { clip, clips, index, projectName, onClose } = handle.props
    const filmDurationMs = clips.reduce((sum, item) => sum + effectiveDurationMs(item), 0)
    const facts = buildClipFacts(clip, {
      index,
      clipCount: clips.length,
      filmDurationMs,
    })
    const photo = isImageClip(clip)
    const canTrim = clipHasUnusedMedia(clip)
    const canSplit = canSplitClip(clip)
    const qualityPlan = photo ? null : planClipQualityReduction(clip)
    const working = busy !== null

    return (
      <>
        <div
          className="sheet-backdrop"
          mix={on('click', () => {
            if (!working) onClose()
          })}
        />
        <div
          className="sheet clip-info-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={`${photo ? 'Photo' : 'Clip'} ${index + 1} info`}
          mix={ref((node, signal) =>
            attachSheetModal(node as HTMLElement, signal, {
              onDismiss: () => handle.props.onClose(),
              busy: () => busy !== null,
            }),
          )}
        >
          <h3>{photo ? 'Photo' : 'Clip'} {index + 1}</h3>
          <p className="sheet-lede muted">{projectName}</p>
          <dl className="clip-info-facts">
            {facts.map((fact) => (
              <div key={fact.label} className="clip-info-fact">
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>

          {clipMismatchesFilm(clip, handle.props.filmOrientation) ? (
            <div className="clip-info-fit" role="group" aria-label="Fit in film">
              <p className="clip-info-fit-label">This clip does not match the film</p>
              <div className="clip-info-fit-toggles">
                {(['crop', 'letterbox'] as const).map((choice) => {
                  const active = clipFit(clip) === choice
                  return (
                    <button
                      type="button"
                      key={choice}
                      className={`btn btn-ghost clip-info-fit-btn${active ? ' is-active' : ''}`}
                      aria-pressed={active}
                      disabled={working}
                      mix={on('click', () => {
                        if (active || working) return
                        void handle.props.onSetFit(choice)
                      })}
                    >
                      {choice === 'crop' ? <IconCrop size={16} /> : <IconLetterbox size={16} />}
                      {choice === 'crop' ? 'Crop' : 'Letterbox'}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}

          {error ? <p className="sheet-message is-error">{error}</p> : null}

          {confirming === 'trim' ? (
            <p className="sheet-message">
              This deletes the unused start and end from the file. You cannot undo
              it.
            </p>
          ) : null}
          {confirming === 'quality' && qualityPlan ? (
            <p className="sheet-message">
              This permanently replaces the clip with {qualityPlan.summary}. You cannot
              undo it.
            </p>
          ) : null}

          <div className="clip-info-actions">
            {photo ? null : confirming === 'trim' ? (
              <div className="sheet-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={working}
                  data-sheet-focus
                  mix={on('click', () => {
                    confirming = null
                    void handle.update()
                  })}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary confirm-sheet-danger"
                  disabled={working}
                  mix={on('click', () =>
                    run('trim', () => handle.props.onPermanentlyTrim()),
                  )}
                >
                  {busy === 'trim' ? 'Deleting…' : 'Delete unused parts'}
                </button>
              </div>
            ) : confirming === 'quality' ? (
              <div className="sheet-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={working}
                  data-sheet-focus
                  mix={on('click', () => {
                    confirming = null
                    void handle.update()
                  })}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary confirm-sheet-danger"
                  disabled={working}
                  mix={on('click', () =>
                    run('quality', () => handle.props.onReduceQuality()),
                  )}
                >
                  {busy === 'quality' ? 'Replacing…' : 'Replace permanently'}
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-ghost clip-info-action"
                  disabled={working || !canTrim}
                  mix={on('click', () => {
                    if (!canTrim) return
                    confirming = 'trim'
                    void handle.update()
                  })}
                >
                  <IconTrim size={18} />
                  Permanently trim
                </button>
                <button
                  type="button"
                  className="btn btn-ghost clip-info-action"
                  disabled={working || !qualityPlan}
                  mix={on('click', () => {
                    if (!qualityPlan) return
                    confirming = 'quality'
                    void handle.update()
                  })}
                >
                  <IconCompress size={18} />
                  Reduce quality
                </button>
              </>
            )}
            {photo ? null : (
              <button
                type="button"
                className="btn btn-ghost clip-info-action"
                disabled={working || !canSplit}
                mix={on('click', () => {
                  if (!canSplit || working) return
                  handle.props.onStartSplit()
                })}
              >
                <IconSplit size={18} />
                Split clip
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost clip-info-action"
              disabled={working}
              data-sheet-focus={confirming ? undefined : true}
              mix={on('click', () => run('download', () => handle.props.onDownload()))}
            >
              <IconDownload size={18} />
              {busy === 'download' ? 'Downloading…' : 'Download'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={working}
              mix={on('click', () => onClose())}
            >
              Close
            </button>
          </div>
          {photo ? (
            <p className="clip-info-hint muted">Photos can be downloaded; trim and split are for video clips.</p>
          ) : confirming ? null : (
            <>
              {!canTrim ? (
                <p className="clip-info-hint muted">
                  Trim the clip first, then permanently delete the unused parts.
                </p>
              ) : null}
              {!qualityPlan ? (
                <p className="clip-info-hint muted">This clip is already a small file.</p>
              ) : (
                <p className="clip-info-hint muted">
                  Reduce quality replaces the file with a smaller encode. That cannot be undone.
                </p>
              )}
              {canSplit ? (
                <p className="clip-info-hint muted">
                  Split opens a handle on the filmstrip so you can choose the cut.
                </p>
              ) : null}
            </>
          )}
        </div>
      </>
    )
  }
}
