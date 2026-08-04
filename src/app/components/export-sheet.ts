/**
 * OK Video-style export flow: tapping Go immediately starts the export,
 * then Share / Save run from fresh taps so the system share sheet always
 * has the user activation it requires.
 */

import { define, h, KvElement, type Child } from '../dom.ts'
import { brandMark } from './brand-mark.ts'
import { sheetShell } from './sheet-shell.ts'

export interface ExportSheetProps {
  status: 'ready' | 'error'
  error: string | null
  /** Whether the exported file can go through the system share sheet. */
  canShare: boolean
  fileExtension: string | null
  fileSizeBytes: number | null
  /** Feedback after a share/save action ("Saved to downloads", …). */
  notice: string | null
  /** True when THIS export was stamped with the Kody Video mark. */
  watermarked: boolean
  /** True when the removal purchase is unlocked (may change mid-sheet). */
  purchased: boolean
  /** A share/save is in flight — dismissal would drop its result notice. */
  busy: boolean
  onShare: () => void
  onSave: () => void
  onSaveClips: () => void
  onRemoveWatermark: () => void
  onRestorePurchase: () => void
  onRetry: () => void
  /** Fresh render, bypassing the persisted last-export cache. */
  onReExport: () => void
  onClose: () => void
}

function formatFileInfo(ext: string | null, bytes: number | null): string {
  const type = ext ? ext.toUpperCase() : 'Video'
  if (bytes === null) return type
  const mb = bytes / (1024 * 1024)
  return `${type} · ${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`
}

export class KvExportSheet extends KvElement<ExportSheetProps> {
  #dialog: HTMLDivElement | null = null

  /** Parent re-assigns props (notice/busy changes) and calls update(). */
  override update(): void {
    if (this.isConnected && this.#dialog) this.renderContent()
  }

  override render(): void {
    this.#dialog = sheetShell(this, {
      className: 'export-sheet',
      label: 'Share project',
      onDismiss: () => this.props.onClose(),
      busy: () => this.props.busy,
    })
    this.renderContent()
  }

  renderContent(): void {
    const dialog = this.#dialog
    if (!dialog) return
    const {
      status,
      error,
      canShare,
      fileExtension,
      fileSizeBytes,
      notice,
      watermarked,
      purchased,
      busy,
      onShare,
      onSave,
      onSaveClips,
      onRemoveWatermark,
      onRestorePurchase,
      onRetry,
      onReExport,
      onClose,
    } = this.props

    const btn = (className: string, label: string, onclick: () => void, disabled = busy) =>
      h('button', { type: 'button', className, disabled, onclick }, label)
    const linkBtn = (label: string, onclick: () => void, disabled = busy) =>
      h('button', { type: 'button', className: 'link-button', disabled, onclick }, label)

    if (status === 'ready') {
      const children: Child[] = [
        brandMark({ size: 84, className: 'export-celebrate-art', variant: 'share' }),
        h('h3', null, 'Done! Your video is ready'),
        h(
          'p',
          { className: 'muted sheet-lede' },
          `${formatFileInfo(fileExtension, fileSizeBytes)} — it stays on this device until you share it.`,
        ),
        notice ? h('p', { className: 'sheet-message' }, notice) : null,
        h(
          'div',
          { className: 'sheet-actions' },
          canShare ? btn('btn btn-primary', 'Share', () => onShare()) : null,
          btn(`btn ${canShare ? 'btn-secondary' : 'btn-primary'}`, 'Save', () => onSave()),
          btn('btn btn-ghost', 'Done', () => onClose()),
        ),
        h(
          'p',
          { className: 'sheet-utility-links' },
          linkBtn('Save original clips (.zip)', () => onSaveClips()),
          ' · ',
          linkBtn('Re-export from scratch', () => onReExport()),
        ),
        watermarked && !purchased
          ? h(
              'p',
              { className: 'watermark-note' },
              'Includes a small Kody mark in the corner. ',
              linkBtn(
                'Get Plus — $0.99 removes it & unlocks 6 projects',
                () => onRemoveWatermark(),
                false,
              ),
              ' · ',
              linkBtn('Already paid?', () => onRestorePurchase(), false),
            )
          : null,
        watermarked && purchased
          ? h(
              'p',
              { className: 'watermark-note' },
              'This video still includes the Kody mark — tap Go again for a clean export.',
            )
          : null,
      ]
      dialog.replaceChildren()
      for (const child of children) if (child) dialog.append(child as Node)
      return
    }

    dialog.replaceChildren(
      h('h3', null, 'Export hit a snag'),
      h('p', { className: 'sheet-message is-error' }, error ?? 'Something went wrong.'),
      ...(notice ? [h('p', { className: 'sheet-message' }, notice)] : []),
      h(
        'div',
        { className: 'sheet-actions' },
        btn('btn btn-primary', 'Try again', () => onRetry()),
        btn('btn btn-secondary', 'Save clips (.zip) instead', () => onSaveClips()),
        btn('btn btn-ghost', 'Close', () => onClose()),
      ),
    )
  }
}
define('kv-export-sheet', KvExportSheet)
