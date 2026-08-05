import type { Handle } from 'remix/ui'
import { ref } from 'remix/ui'
import { formatDuration } from '../lib/types'

interface RecordTimerProps {
  /** performance.now() timestamp when recording started. */
  startedAt: number
  className?: string
}

/**
 * Self-updating elapsed readout. Writes the text node directly from rAF so
 * the rest of the page never re-renders while recording — re-rendering the
 * whole screen 60×/s is what made the camera preview and encoder drop frames.
 *
 * The readout is rendered as a real (vdom-owned) text child and the rAF loop
 * mutates that same node's data. Rendering the span EMPTY and relying on
 * textContent alone looks equivalent, but the reconciler bulk-clears the
 * children of any element whose vnode has none — so every mid-take re-render
 * (zoom sync, mic-silent warning) blanked the readout for up to 100ms and
 * the pill visibly collapsed/re-expanded: the "recording counter jitter".
 */
export function RecordTimer(handle: Handle<RecordTimerProps>) {
  const elapsedText = () =>
    formatDuration(Math.max(0, performance.now() - handle.props.startedAt))

  return () => (
    <span
      className={handle.props.className}
      mix={ref((node, signal) => {
        let raf = 0
        let lastText = ''
        const tick = () => {
          const text = elapsedText()
          // The readout has 0.1s resolution, so ~5 of 6 frames would write
          // the same string — and every text write dirties layout.
          // Skipping no-ops keeps recording free of per-frame layout work.
          if (text !== lastText) {
            lastText = text
            // Mutate the existing text node (never replace it): the vdom
            // holds a reference to this node, and re-renders must keep
            // patching the node that is actually on screen.
            const textNode = node.firstChild
            if (textNode) textNode.nodeValue = text
            else node.textContent = text
          }
          raf = requestAnimationFrame(tick)
        }
        tick()
        signal.addEventListener('abort', () => cancelAnimationFrame(raf))
      })}
    >
      {elapsedText()}
    </span>
  )
}
