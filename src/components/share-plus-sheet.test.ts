import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, createRoot, type Handle } from 'remix/ui'

/**
 * Regression for Sentry 7685051724: a sync handle.update() kicked from setup
 * (before any await) is ignored with a console warning, and one that lands
 * before the initial render commits throws "Cannot call handle.update()".
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

  it('does not warn or reject when load starts during setup', async () => {
    const rejections: string[] = []
    const onRejection = (event: PromiseRejectionEvent) => {
      const msg =
        event.reason instanceof Error ? event.reason.message : String(event.reason ?? '')
      if (msg.includes('handle.update()') || msg.includes('scheduleUpdate')) {
        rejections.push(msg)
        event.preventDefault()
      }
    }
    window.addEventListener('unhandledrejection', onRejection)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    dispose = () => {
      window.removeEventListener('unhandledrejection', onRejection)
      warn.mockRestore()
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
    expect(
      warn.mock.calls.filter(([msg]) => String(msg).includes('handle.update()')),
    ).toEqual([])
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
