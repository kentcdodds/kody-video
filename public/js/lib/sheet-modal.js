/** Mounted sheets, in stacking order — only the topmost owns the keyboard
 * (RestoreSheet opens on top of ExportSheet; Escape must peel one layer). */
const sheetStack = [];
/**
 * Modal behavior for bottom sheets: Escape dismisses (unless busy), Tab is
 * trapped inside the sheet, initial focus lands on `[data-sheet-focus]` (or
 * the first focusable), and focus returns to the opener on close. Attach via
 * the `ref()` mixin on the sheet's dialog element and add `aria-modal="true"`.
 */
export function attachSheetModal(element, signal, options) {
    sheetStack.push(element);
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event) => {
        // Stacked sheets: only the topmost handles keys (the lower sheet's
        // listener must neither trap Tab nor dismiss on the same Escape).
        if (sheetStack[sheetStack.length - 1] !== element)
            return;
        if (event.key === 'Escape') {
            // Capture-phase stop: the sheet's Escape must never also trigger
            // screen-level shortcuts (e.g. the editor's back-to-camera).
            event.stopPropagation();
            if (!options.busy?.())
                options.onDismiss();
            return;
        }
        if (event.key !== 'Tab')
            return;
        const focusables = [
            ...element.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
        ].filter((candidate) => !candidate.hasAttribute('disabled'));
        if (focusables.length === 0) {
            // Everything is disabled mid-action: hold focus in place rather than
            // letting Tab escape behind the modal.
            event.preventDefault();
            return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const inside = active !== null && element.contains(active);
        if (!inside) {
            event.preventDefault();
            first.focus();
            return;
        }
        if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
        }
        else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    const initial = element.querySelector('[data-sheet-focus]') ??
        element.querySelector('button:not([disabled]), [href], input, select, textarea');
    initial?.focus();
    signal.addEventListener('abort', () => {
        const index = sheetStack.indexOf(element);
        if (index >= 0)
            sheetStack.splice(index, 1);
        window.removeEventListener('keydown', onKeyDown, { capture: true });
        previousFocus?.focus();
    });
}
