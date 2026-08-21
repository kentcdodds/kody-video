import { afterEach, describe, expect, it } from 'vitest'
import { createElement, createRoot, type Handle } from 'remix/ui'

/**
 * Regression for Sentry 7685051724: Remix only wires scheduleUpdate after the
 * first render commits. A sync handle.update() kicked from setup (before any
 * await) rejects with "scheduleUpdate not implemented".
 *
 * Mirrors SharePlusSheet's mount load: start busy=true, skip the sync busy
 * paint, then update after the first await when the runtime is connected.
 */
function SheetSetupLoad(handle: Handle) {
  let busy = true
  let error: string | null = null
  let code: string | null = null

  const load = async () => {
    const needsBusyPaint = !busy || error !== null || code !== null
    busy = true
    error = null
    code = null
    if (needsBusyPaint) void handle.update()
    await Promise.resolve()
    busy = false
    code = 'ABC234'
    if (!handle.signal.aborted) void handle.update()
  }

  void load()

  return () =>
    createElement(
      'div',
      { role: 'dialog' },
      busy ? 'Making a short code…' : null,
      code ? createElement('p', { className: 'sync-code' }, code) : null,
    )
}

describe('SharePlusSheet setup load', () => {
  let dispose: (() => void) | undefined

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('does not reject scheduleUpdate when load starts during setup', async () => {
    const rejections: string[] = []
    const onRejection = (event: PromiseRejectionEvent) => {
      const msg =
        event.reason instanceof Error ? event.reason.message : String(event.reason ?? '')
      if (msg.includes('scheduleUpdate')) {
        rejections.push(msg)
        event.preventDefault()
      }
    }
    window.addEventListener('unhandledrejection', onRejection)

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    dispose = () => {
      window.removeEventListener('unhandledrejection', onRejection)
      root.dispose()
      host.remove()
    }

    root.render(createElement(SheetSetupLoad))
    root.flush()

    await waitFor(() => {
      root.flush()
      expect(host.querySelector('.sync-code')?.textContent).toBe('ABC234')
    })

    expect(rejections).toEqual([])
  })
})

async function waitFor(assert: () => void, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  let last: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      assert()
      return
    } catch (err) {
      last = err
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}
