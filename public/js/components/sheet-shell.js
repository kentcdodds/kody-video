import { h } from '../dom.js'
import { attachSheetModal } from '../lib/sheet-modal.js'

/**
 * Shared bottom-sheet scaffolding: backdrop + dialog with modality
 * (focus trap, Esc, sheet stack) attached for the host element's lifetime.
 * The host is a custom element; returns the dialog to render content into.
 */
export function sheetShell(host, { className = '', label, onDismiss, busy }) {
  const backdrop = h('div', {
    className: 'sheet-backdrop',
    onclick: () => {
      if (!busy?.()) onDismiss()
    },
  })
  const dialog = h('div', {
    className: `sheet${className ? ` ${className}` : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': label,
  })
  host.replaceChildren(backdrop, dialog)
  attachSheetModal(dialog, host.signal, { onDismiss, busy })
  return dialog
}
