/**
 * Bottom sheets: confirm, rename, home options, upsell, and restore.
 * Each is a custom element created fresh per opening (the parent appends it
 * with `props` set) — internal state is plain fields + imperative updates,
 * so inputs keep focus while typing.
 */

import { define, h, KvElement } from '../dom.js'
import { extractSessionId, verifyPurchaseSession, REMOVE_WATERMARK_LINK } from '../lib/entitlement.js'
import { MAX_PROJECTS } from '../lib/types.js'
import { sheetShell } from './sheet-shell.js'

/** Destructive confirmation bottom sheet (replaces window.confirm). */
export class KvConfirmSheet extends KvElement {
  render() {
    const { title, message, confirmLabel = 'Delete', cancelLabel = 'Cancel', onConfirm, onClose } =
      this.props
    let busy = false
    const dialog = sheetShell(this, {
      className: 'confirm-sheet',
      label: title,
      onDismiss: onClose,
      busy: () => busy,
    })

    const cancelButton = h(
      'button',
      { type: 'button', className: 'btn btn-ghost', 'data-sheet-focus': true, onclick: () => onClose() },
      cancelLabel,
    )
    const confirmButton = h(
      'button',
      {
        type: 'button',
        className: 'btn btn-primary confirm-sheet-danger',
        onclick: async () => {
          busy = true
          cancelButton.disabled = true
          confirmButton.disabled = true
          confirmButton.textContent = 'Working…'
          try {
            await onConfirm()
            onClose()
          } finally {
            busy = false
            cancelButton.disabled = false
            confirmButton.disabled = false
            confirmButton.textContent = confirmLabel
          }
        },
      },
      confirmLabel,
    )
    dialog.replaceChildren(
      h('h3', null, title),
      h('p', { className: 'sheet-lede muted' }, message),
      // Destructive dialog: initial focus lands on the safe action.
      h('div', { className: 'sheet-actions' }, cancelButton, confirmButton),
    )
    // sheetShell focused before the buttons existed — focus the safe action.
    cancelButton.focus()
  }
}
define('kv-confirm-sheet', KvConfirmSheet)

/** Rename (or generic single-field) sheet. */
export class KvRenameSheet extends KvElement {
  render() {
    const { initialName, title = 'Rename project', confirmLabel = 'Save', onClose, onSave } =
      this.props
    let busy = false

    const dialog = sheetShell(this, {
      label: title,
      onDismiss: onClose,
      busy: () => busy,
    })

    const errorBanner = h('div', { className: 'error-banner', hidden: true })
    const input = h('input', {
      id: 'project-name',
      type: 'text',
      value: initialName,
      maxLength: 48,
      oninput: () => {
        saveButton.disabled = busy || !input.value.trim()
      },
      onkeydown: (event) => {
        if (event.key === 'Enter' && !saveButton.disabled) save()
      },
    })
    const cancelButton = h(
      'button',
      { type: 'button', className: 'btn btn-ghost', onclick: () => onClose() },
      'Cancel',
    )
    const saveButton = h(
      'button',
      { type: 'button', className: 'btn btn-primary', onclick: () => save() },
      confirmLabel,
    )

    const save = async () => {
      busy = true
      errorBanner.hidden = true
      cancelButton.disabled = true
      saveButton.disabled = true
      saveButton.textContent = 'Saving…'
      try {
        await onSave(input.value.trim())
        onClose()
      } catch (err) {
        errorBanner.textContent = err instanceof Error ? err.message : 'Could not save'
        errorBanner.hidden = false
      } finally {
        busy = false
        if (this.isConnected) {
          cancelButton.disabled = false
          saveButton.disabled = !input.value.trim()
          saveButton.textContent = confirmLabel
        }
      }
    }

    dialog.replaceChildren(
      h('h3', null, title),
      h('div', { className: 'field' }, h('label', { htmlFor: 'project-name' }, 'Name'), input),
      errorBanner,
      h('div', { className: 'sheet-actions' }, cancelButton, saveButton),
    )
    input.focus()
    input.select()
  }
}
define('kv-rename-sheet', KvRenameSheet)

/** Bottom sheet with Open / Rename / Backup / Delete for a filled slot. */
export class KvHomeOptionsSheet extends KvElement {
  render() {
    const { projectName, onOpen, onRename, onBackup, onDelete, onClose } = this.props
    const dialog = sheetShell(this, {
      className: 'home-options-sheet',
      label: `Options for ${projectName}`,
      onDismiss: onClose,
    })
    const option = (label, onclick, danger = false) =>
      h(
        'button',
        {
          type: 'button',
          className: `home-option-btn${danger ? ' home-option-danger' : ''}`,
          onclick,
        },
        label,
      )
    dialog.replaceChildren(
      h('h3', null, projectName),
      h('p', { className: 'sheet-lede muted' }, 'What do you want to do?'),
      h(
        'div',
        { className: 'home-options-list' },
        option('Open', () => onOpen()),
        option('Rename', () => onRename()),
        option('Save backup', () => onBackup()),
        option('Delete', () => onDelete(), true),
      ),
      h(
        'div',
        { className: 'sheet-actions' },
        h('button', { type: 'button', className: 'btn btn-ghost', onclick: () => onClose() }, 'Cancel'),
      ),
    )
  }
}
define('kv-home-options-sheet', KvHomeOptionsSheet)

/** The one-time Kody Video Plus purchase: watermark removal + more projects. */
export class KvUpsellSheet extends KvElement {
  render() {
    const { onClose, onRestore } = this.props
    const dialog = sheetShell(this, { label: 'Kody Video Plus', onDismiss: onClose })
    dialog.replaceChildren(
      h('h3', null, 'Kody Video Plus'),
      h(
        'p',
        { className: 'sheet-copy' },
        `The free plan includes 1 project. Plus is a one-time $0.99 purchase that unlocks ` +
          `${MAX_PROJECTS} project slots and removes the watermark from exports — forever, on ` +
          `this device and any device you restore it on.`,
      ),
      h(
        'div',
        { className: 'sheet-actions' },
        h('button', { type: 'button', className: 'btn btn-ghost', onclick: () => onClose() }, 'Not now'),
        h(
          'button',
          {
            type: 'button',
            className: 'btn btn-primary',
            onclick: () => {
              window.open(REMOVE_WATERMARK_LINK, '_blank', 'noopener')
              onClose()
            },
          },
          'Get Plus — $0.99',
        ),
      ),
      h(
        'button',
        { type: 'button', className: 'link-button sheet-footnote', onclick: () => onRestore() },
        'Already paid? Restore your purchase',
      ),
    )
  }
}
define('kv-upsell-sheet', KvUpsellSheet)

/**
 * Restore the purchase on a new device: paste the link from the Stripe
 * receipt email (or the checkout session id) and re-verify.
 */
export class KvRestoreSheet extends KvElement {
  render() {
    const { onRestored, onClose } = this.props
    let busy = false

    const dialog = sheetShell(this, {
      label: 'Restore purchase',
      onDismiss: onClose,
      busy: () => busy,
    })

    const errorBanner = h('div', { className: 'error-banner', hidden: true })
    const input = h('input', {
      id: 'restore-input',
      type: 'text',
      placeholder: 'https://… or cs_live_…',
      oninput: () => {
        restoreButton.disabled = busy || !extractSessionId(input.value)
      },
    })
    const cancelButton = h(
      'button',
      { type: 'button', className: 'btn btn-ghost', onclick: () => onClose() },
      'Cancel',
    )
    const restoreButton = h(
      'button',
      {
        type: 'button',
        className: 'btn btn-primary',
        disabled: true,
        onclick: async () => {
          const sessionId = extractSessionId(input.value)
          if (!sessionId) return
          busy = true
          errorBanner.hidden = true
          cancelButton.disabled = true
          restoreButton.disabled = true
          restoreButton.textContent = 'Verifying…'
          const result = await verifyPurchaseSession(sessionId)
          busy = false
          if (result.unlocked) {
            onRestored()
            return
          }
          errorBanner.textContent = result.error ?? 'Could not verify the purchase.'
          errorBanner.hidden = false
          if (this.isConnected) {
            cancelButton.disabled = false
            restoreButton.disabled = !extractSessionId(input.value)
            restoreButton.textContent = 'Restore'
          }
        },
      },
      'Restore',
    )

    dialog.replaceChildren(
      h('h3', null, 'Restore purchase'),
      h(
        'p',
        { className: 'muted sheet-lede' },
        'Paste the confirmation link from your Stripe receipt email (or the checkout session id ' +
          'starting with “cs_”). We’ll verify it and remove the watermark on this device.',
      ),
      h(
        'div',
        { className: 'field' },
        h('label', { htmlFor: 'restore-input' }, 'Receipt link or session id'),
        input,
      ),
      errorBanner,
      h('div', { className: 'sheet-actions' }, cancelButton, restoreButton),
    )
    input.focus()
  }
}
define('kv-restore-sheet', KvRestoreSheet)
