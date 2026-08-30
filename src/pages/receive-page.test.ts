import { afterEach, describe, expect, it } from 'vitest'
import { createElement, createRoot, type Handle } from 'remix/ui'

/**
 * Regression for Sentry 7700116197: Remix only wires scheduleUpdate after the
 * first render commits. A sync handle.update() kicked from ReceivePage setup
 * (deep-link code → receive() before any await) rejects with
 * "scheduleUpdate not implemented".
 *
 * Mirrors ReceivePage's mount path: start in waiting with a code, skip the
 * sync waiting paint, then update after the first await when connected.
 */
function ReceiveSetupWithCode(handle: Handle<{ code: string }>) {
  const propCode = handle.props.code
  let phase: 'waiting' | 'transferring' | 'done' = 'waiting'
  let progress = ''
  const abort = new AbortController()
  handle.signal.addEventListener('abort', () => abort.abort(), { once: true })

  const receive = (code: string) => {
    const needsWaitingPaint = phase !== 'waiting' || progress !== ''
    phase = 'waiting'
    progress = ''
    if (needsWaitingPaint) void handle.update()
    void (async () => {
      await Promise.resolve()
      if (abort.signal.aborted) return
      phase = 'transferring'
      progress = `got:${code}`
      void handle.update()
      await Promise.resolve()
      if (abort.signal.aborted) return
      phase = 'done'
      void handle.update()
    })()
  }

  if (propCode) receive(propCode)

  return () =>
    createElement(
      'div',
      { 'data-phase': phase },
      phase === 'waiting' ? 'Waiting for the sender.' : null,
      progress ? createElement('p', { className: 'export-percent' }, progress) : null,
      phase === 'done' ? 'Project received.' : null,
    )
}

describe('ReceivePage setup receive', () => {
  let dispose: (() => void) | undefined

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('does not reject scheduleUpdate when receive starts during setup', async () => {
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

    root.render(createElement(ReceiveSetupWithCode, { code: 'AB3K9Q' }))
    root.flush()

    await waitFor(() => {
      root.flush()
      expect(host.textContent).toContain('Project received.')
      expect(host.querySelector('.export-percent')?.textContent).toBe('got:AB3K9Q')
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
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw last instanceof Error ? last : new Error(String(last))
}
