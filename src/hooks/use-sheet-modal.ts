import { useCallback, useLayoutEffect, useRef, type RefCallback } from 'react'

interface SheetModalOptions {
  onDismiss: () => void
  /** Blocks Esc dismissal while an action is in flight. */
  busy?: boolean
}

/**
 * Modal behavior for bottom sheets: Escape dismisses (unless busy), Tab is
 * trapped inside the sheet, initial focus lands on `[data-sheet-focus]` (or
 * the first focusable), and focus returns to the opener on close. Attach the
 * returned ref to the sheet's dialog element and add `aria-modal="true"`.
 */
export function useSheetModal({ onDismiss, busy }: SheetModalOptions): RefCallback<HTMLElement> {
  const optionsRef = useRef({ onDismiss, busy })
  useLayoutEffect(() => {
    optionsRef.current = { onDismiss, busy }
  })
  const elementRef = useRef<HTMLElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    const element = elementRef.current
    if (!element) return
    if (event.key === 'Escape') {
      // Capture-phase stop: the sheet's Escape must never also trigger
      // screen-level shortcuts (e.g. the editor's back-to-camera).
      event.stopPropagation()
      if (!optionsRef.current.busy) optionsRef.current.onDismiss()
      return
    }
    if (event.key !== 'Tab') return
    const focusables = [
      ...element.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((candidate) => !candidate.hasAttribute('disabled'))
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const inside = active !== null && element.contains(active)
    if (!inside) {
      event.preventDefault()
      first.focus()
      return
    }
    if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }, [])

  return useCallback(
    (element: HTMLElement | null) => {
      if (element) {
        elementRef.current = element
        previousFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        window.addEventListener('keydown', onKeyDown, true)
        const initial =
          element.querySelector<HTMLElement>('[data-sheet-focus]') ??
          element.querySelector<HTMLElement>(
            'button:not([disabled]), [href], input, select, textarea',
          )
        initial?.focus()
      } else {
        elementRef.current = null
        window.removeEventListener('keydown', onKeyDown, true)
        previousFocusRef.current?.focus()
        previousFocusRef.current = null
      }
    },
    [onKeyDown],
  )
}
