/**
 * OK Video-style export flow: tapping Go immediately starts the export,
 * then Share / Save run from fresh taps so the system share sheet always
 * has the user activation it requires.
 */
import { define, h, KvElement } from "../dom.js";
import { brandMark } from "./brand-mark.js";
import { sheetShell } from "./sheet-shell.js";
function formatFileInfo(ext, bytes) {
    const type = ext ? ext.toUpperCase() : 'Video';
    if (bytes === null)
        return type;
    const mb = bytes / (1024 * 1024);
    return `${type} · ${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}
export class KvExportSheet extends KvElement {
    #dialog = null;
    /** Parent re-assigns props (notice/busy changes) and calls update(). */
    update() {
        if (this.isConnected && this.#dialog)
            this.renderContent();
    }
    render() {
        this.#dialog = sheetShell(this, {
            className: 'export-sheet',
            label: 'Share project',
            onDismiss: () => this.props.onClose(),
            busy: () => this.props.busy,
        });
        this.renderContent();
    }
    renderContent() {
        const dialog = this.#dialog;
        if (!dialog)
            return;
        const { status, error, canShare, fileExtension, fileSizeBytes, notice, watermarked, purchased, busy, onShare, onSave, onSaveClips, onRemoveWatermark, onRestorePurchase, onRetry, onReExport, onClose, } = this.props;
        const btn = (className, label, onclick, disabled = busy) => h('button', { type: 'button', className, disabled, onclick }, label);
        const linkBtn = (label, onclick, disabled = busy) => h('button', { type: 'button', className: 'link-button', disabled, onclick }, label);
        if (status === 'ready') {
            const children = [
                brandMark({ size: 84, className: 'export-celebrate-art', variant: 'share' }),
                h('h3', null, 'Done! Your video is ready'),
                h('p', { className: 'muted sheet-lede' }, `${formatFileInfo(fileExtension, fileSizeBytes)} — it stays on this device until you share it.`),
                notice ? h('p', { className: 'sheet-message' }, notice) : null,
                h('div', { className: 'sheet-actions' }, canShare ? btn('btn btn-primary', 'Share', () => onShare()) : null, btn(`btn ${canShare ? 'btn-secondary' : 'btn-primary'}`, 'Save', () => onSave()), btn('btn btn-ghost', 'Done', () => onClose())),
                h('p', { className: 'sheet-utility-links' }, linkBtn('Save original clips (.zip)', () => onSaveClips()), ' · ', linkBtn('Re-export from scratch', () => onReExport())),
                watermarked && !purchased
                    ? h('p', { className: 'watermark-note' }, 'Includes a small Kody mark in the corner. ', linkBtn('Get Plus — $0.99 removes it & unlocks 6 projects', () => onRemoveWatermark(), false), ' · ', linkBtn('Already paid?', () => onRestorePurchase(), false))
                    : null,
                watermarked && purchased
                    ? h('p', { className: 'watermark-note' }, 'This video still includes the Kody mark — tap Go again for a clean export.')
                    : null,
            ];
            dialog.replaceChildren();
            for (const child of children)
                if (child)
                    dialog.append(child);
            return;
        }
        dialog.replaceChildren(h('h3', null, 'Export hit a snag'), h('p', { className: 'sheet-message is-error' }, error ?? 'Something went wrong.'), ...(notice ? [h('p', { className: 'sheet-message' }, notice)] : []), h('div', { className: 'sheet-actions' }, btn('btn btn-primary', 'Try again', () => onRetry()), btn('btn btn-secondary', 'Save clips (.zip) instead', () => onSaveClips()), btn('btn btn-ghost', 'Close', () => onClose())));
    }
}
define('kv-export-sheet', KvExportSheet);
