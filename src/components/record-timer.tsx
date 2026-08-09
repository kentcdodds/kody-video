import type { Handle } from 'remix/ui'
import { ref } from 'remix/ui'
import { formatDuration } from '../lib/types'

interface RecordTimerProps {
  /** performance.now() timestamp when recording started. */
  startedAt: number
  className?: string
}

/**
 * Self-updating elapsed readout. Writes the text node directly from a
 * coarse timer so the rest of the page never re-renders while recording —
 * re-rendering the whole screen per tick is what made the camera preview
 * and encoder drop frames.
 *
 * Scheduling: the readout has 0.1s resolution, so it ticks ~10×/s from a
 * setTimeout aligned just past the next tenth boundary — NOT from
 * requestAnimationFrame. A per-frame rAF loop (even one that skips
 * redundant writes) forces the main thread to produce a frame 60×/s for
 * the whole take, and every one of those frames also re-evaluates the
 * record pill's (compositor-run) pulse animations — profiled as ~60/s
 * style recalcs + prepaints competing with the preview and encoder.
 *
 * The readout is rendered as a real (vdom-owned) text child and the timer
 * mutates that same node's data. Rendering the span EMPTY and relying on
 * textContent alone looks equivalent, but the reconciler bulk-clears the
 * children of any element whose vnode has none — so every mid-take re-render
 * (zoom sync, mic-silent warning) blanked the readout for up to 100ms and
 * the pill visibly collapsed/re-expanded: the "recording counter jitter".
 */
export function RecordTimer(handle: Handle<RecordTimerProps>) {
  const elapsedMs = () => Math.max(0, performance.now() - handle.props.startedAt)

  return () => (
    <span
      className={handle.props.className}
      mix={ref((node, signal) => {
        let timer = 0
        let lastText = ''
        const tick = () => {
          const text = formatDuration(elapsedMs())
          // A tick can land twice in the same tenth under load — and every
          // text write dirties layout, so skip no-op writes.
          if (text !== lastText) {
            lastText = text
            // Mutate the existing text node (never replace it): the vdom
            // holds a reference to this node, and re-renders must keep
            // patching the node that is actually on screen.
            const textNode = node.firstChild
            if (textNode) textNode.nodeValue = text
            else node.textContent = text
          }
          // Land ~5ms past the next 0.1s boundary so every tenth renders.
          timer = window.setTimeout(tick, 105 - (elapsedMs() % 100))
        }
        tick()
        signal.addEventListener('abort', () => window.clearTimeout(timer))
      })}
    >
      {formatDuration(elapsedMs())}
    </span>
  )
}
