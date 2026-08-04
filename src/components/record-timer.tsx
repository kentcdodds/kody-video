import type { Handle } from 'remix/ui'
import { ref } from 'remix/ui'
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
export function RecordTimer(handle: Handle<RecordTimerProps>) {
  return () => (
    <span
      className={handle.props.className}
      mix={ref((node, signal) => {
        let raf = 0
        const tick = () => {
          node.textContent = formatDuration(
            Math.max(0, performance.now() - handle.props.startedAt),
          )
          raf = requestAnimationFrame(tick)
        }
        tick()
        signal.addEventListener('abort', () => cancelAnimationFrame(raf))
      })}
    />
  )
}
