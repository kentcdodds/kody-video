import { useCallback, useRef } from 'react'
import { formatDuration } from '../lib/types'

interface RecordTimerProps {
  /** performance.now() timestamp when recording started. */
  startedAt: number
  className?: string
}

/**
 * Self-updating elapsed readout. Writes textContent directly from rAF so the
 * rest of the page never re-renders while recording — re-rendering the whole
 * screen 60×/s is what made the camera preview and encoder drop frames.
 */
export function RecordTimer({ startedAt, className }: RecordTimerProps) {
  const rafRef = useRef(0)

  const bind = useCallback(
    (el: HTMLSpanElement | null) => {
      cancelAnimationFrame(rafRef.current)
      if (!el) return
      const tick = () => {
        el.textContent = formatDuration(Math.max(0, performance.now() - startedAt))
        rafRef.current = requestAnimationFrame(tick)
      }
      tick()
    },
    [startedAt],
  )

  return <span ref={bind} className={className} />
}
