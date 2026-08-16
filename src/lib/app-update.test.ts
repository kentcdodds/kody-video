import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyWaitingUpdate,
  checkForUpdates,
  getUpdateDiagnostics,
  isRunningStale,
  probeForUpdates,
  registerUpdateHandles,
  resetAppUpdateForTests,
  stripUpdateNavigationMark,
  UPDATE_NAV_PARAM,
} from './app-update'

function mockRegistration(
  overrides: Partial<ServiceWorkerRegistration> = {},
): ServiceWorkerRegistration {
  return {
    installing: null,
    waiting: null,
    active: null,
    update: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...overrides,
  } as unknown as ServiceWorkerRegistration
}

function mockWaitingWorker(): ServiceWorker {
  return {
    scriptURL: `${location.origin}/sw.js`,
    state: 'installed',
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as ServiceWorker
}

function captureControllerChange() {
  const listeners = new Set<EventListener>()
  const add = navigator.serviceWorker.addEventListener.bind(navigator.serviceWorker)
  const remove = navigator.serviceWorker.removeEventListener.bind(navigator.serviceWorker)
  vi.spyOn(navigator.serviceWorker, 'addEventListener').mockImplementation(
    (type, listener, options) => {
      if (type === 'controllerchange') {
        listeners.add(listener as EventListener)
        return
      }
      add(type, listener as EventListener, options)
    },
  )
  vi.spyOn(navigator.serviceWorker, 'removeEventListener').mockImplementation(
    (type, listener, options) => {
      if (type === 'controllerchange') {
        listeners.delete(listener as EventListener)
        return
      }
      remove(type, listener as EventListener, options)
    },
  )
  return {
    fire() {
      for (const listener of listeners) listener(new Event('controllerchange'))
    },
  }
}

// Browser mode: app-update listens on the real document/window, so tests
// dispatch real events. `document` itself cannot be replaced in Chromium,
// but its visibilityState getter can be shadowed on the instance.
function createDomStub(initialVisibility: DocumentVisibilityState = 'visible') {
  let visibilityState = initialVisibility
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  })
  return {
    setVisibility(next: DocumentVisibilityState) {
      visibilityState = next
    },
    dispatch(type: 'visibilitychange' | 'focus' | 'pageshow') {
      const target = type === 'visibilitychange' ? document : window
      target.dispatchEvent(new Event(type))
    },
  }
}

function restoreVisibilityState() {
  Reflect.deleteProperty(document, 'visibilityState')
}

describe('app-update resume checks', () => {
  beforeEach(() => {
    resetAppUpdateForTests({ minIntervalMs: 1_000, fetchDeployed: async () => null })
  })

  afterEach(() => {
    resetAppUpdateForTests()
    restoreVisibilityState()
    vi.restoreAllMocks()
  })

  it('probes the service worker when the document becomes visible again', () => {
    const dom = createDomStub('visible')
    const update = vi.fn().mockResolvedValue(undefined)
    const reg = mockRegistration({ update })
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    registerUpdateHandles(reg, vi.fn())
    now.mockReturnValue(2_000)

    dom.setVisibility('hidden')
    dom.dispatch('visibilitychange')
    expect(update).not.toHaveBeenCalled()

    dom.setVisibility('visible')
    dom.dispatch('visibilitychange')
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('probes on focus when the tab is visible (iOS resume path)', () => {
    const dom = createDomStub('visible')
    const update = vi.fn().mockResolvedValue(undefined)
    const reg = mockRegistration({ update })
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    registerUpdateHandles(reg, vi.fn())
    now.mockReturnValue(2_000)

    dom.dispatch('focus')
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('throttles rapid resume signals into a single probe', () => {
    const dom = createDomStub('visible')
    const update = vi.fn().mockResolvedValue(undefined)
    const reg = mockRegistration({ update })
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    registerUpdateHandles(reg, vi.fn())
    now.mockReturnValue(2_000)

    dom.dispatch('focus')
    dom.dispatch('pageshow')
    dom.dispatch('visibilitychange')
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('skips the first post-register resume burst', () => {
    const dom = createDomStub('visible')
    const update = vi.fn().mockResolvedValue(undefined)
    const reg = mockRegistration({ update })
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    registerUpdateHandles(reg, vi.fn())
    // Still inside the min-interval window after registration.
    now.mockReturnValue(500)
    dom.dispatch('focus')
    expect(update).not.toHaveBeenCalled()
  })

  it('probeForUpdates does not apply the waiting worker', () => {
    createDomStub()
    const apply = vi.fn()
    const update = vi.fn().mockResolvedValue(undefined)
    const reg = mockRegistration({
      update,
      waiting: {} as ServiceWorker,
    })
    registerUpdateHandles(reg, apply)
    probeForUpdates()
    expect(update).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()
  })

  it('raises the toast on register when this tab is already a retired shell', async () => {
    const notify = vi.fn()
    resetAppUpdateForTests({
      fetchDeployed: async () => ({ commit: 'deployed-sha' }),
      runningSha: 'running-sha',
    })
    registerUpdateHandles(mockRegistration(), vi.fn(), notify)
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
  })

  it('raises the toast when version.json does not match the running bundle', async () => {
    const notify = vi.fn()
    resetAppUpdateForTests({
      fetchDeployed: async () => ({ commit: 'deployed-sha' }),
      runningSha: 'running-sha',
    })
    registerUpdateHandles(mockRegistration(), vi.fn(), notify)
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    notify.mockClear()
    probeForUpdates()
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
  })
})

describe('checkForUpdates (manual)', () => {
  beforeEach(() => {
    resetAppUpdateForTests({ fetchDeployed: async () => null })
  })

  afterEach(() => {
    resetAppUpdateForTests()
    restoreVisibilityState()
    vi.restoreAllMocks()
  })

  it('returns unavailable when no registration is set', async () => {
    await expect(checkForUpdates()).resolves.toBe('unavailable')
  })

  it('returns current when update finds no new worker', async () => {
    createDomStub()
    vi.useFakeTimers()
    const reg = mockRegistration()
    registerUpdateHandles(reg, vi.fn())
    const resultPromise = checkForUpdates()
    await vi.advanceTimersByTimeAsync(1_500)
    await expect(resultPromise).resolves.toBe('current')
    vi.useRealTimers()
  })

  it('applies a waiting worker instead of reporting current', async () => {
    const waiting = mockWaitingWorker()
    const navigate = vi.fn()
    const purge = vi.fn()
    resetAppUpdateForTests({
      fetchDeployed: async () => null,
      navigate,
      purge,
      claimTimeoutMs: 5_000,
    })
    const controller = captureControllerChange()
    registerUpdateHandles(mockRegistration({ waiting }), vi.fn())

    const resultPromise = checkForUpdates()
    await vi.waitFor(() => expect(waiting.postMessage).toHaveBeenCalled())
    controller.fire()
    await expect(resultPromise).resolves.toBe('updated')
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(String(navigate.mock.calls[0]?.[0])).toContain(`${UPDATE_NAV_PARAM}=`)
    expect(purge).not.toHaveBeenCalled()
  })

  it('purges and reloads when the running SHA does not match version.json', async () => {
    const navigate = vi.fn()
    const purge = vi.fn().mockResolvedValue(undefined)
    resetAppUpdateForTests({
      fetchDeployed: async () => ({ commit: 'deployed-sha' }),
      runningSha: 'running-sha',
      navigate,
      purge,
    })
    registerUpdateHandles(mockRegistration(), vi.fn())
    await expect(checkForUpdates()).resolves.toBe('updated')
    expect(purge).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledTimes(1)
  })
})

describe('applyWaitingUpdate', () => {
  afterEach(() => {
    resetAppUpdateForTests()
    vi.restoreAllMocks()
  })

  it('navigates after the waiting worker claims the page', async () => {
    const waiting = mockWaitingWorker()
    const navigate = vi.fn()
    const purge = vi.fn()
    resetAppUpdateForTests({
      fetchDeployed: async () => null,
      navigate,
      purge,
      claimTimeoutMs: 5_000,
    })
    const controller = captureControllerChange()
    registerUpdateHandles(mockRegistration({ waiting }), vi.fn())

    const resultPromise = applyWaitingUpdate()
    await vi.waitFor(() => expect(waiting.postMessage).toHaveBeenCalled())
    controller.fire()
    await expect(resultPromise).resolves.toBe('updated')
    expect(purge).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(getUpdateDiagnostics().events.map((event) => event.phase)).toEqual([
      'apply-start',
      'claim',
    ])
  })

  it('does not purge when the toast is tapped and no worker is waiting', async () => {
    const navigate = vi.fn()
    const purge = vi.fn()
    resetAppUpdateForTests({
      fetchDeployed: async () => ({ commit: 'same-sha' }),
      runningSha: 'same-sha',
      navigate,
      purge,
    })
    registerUpdateHandles(mockRegistration(), vi.fn())
    await expect(applyWaitingUpdate()).resolves.toBe('unavailable')
    expect(purge).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    expect(getUpdateDiagnostics().events.map((event) => event.phase)).toEqual([
      'apply-start',
      'no-worker',
    ])
  })

  it('purges a stale shell even when no worker is waiting', async () => {
    const navigate = vi.fn()
    const purge = vi.fn().mockResolvedValue(undefined)
    resetAppUpdateForTests({
      fetchDeployed: async () => ({ commit: 'deployed-sha' }),
      runningSha: 'running-sha',
      navigate,
      purge,
    })
    registerUpdateHandles(mockRegistration(), vi.fn())
    await expect(applyWaitingUpdate()).resolves.toBe('updated')
    expect(purge).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('purges caches when the waiting worker never claims', async () => {
    const waiting = mockWaitingWorker()
    const navigate = vi.fn()
    const purge = vi.fn().mockResolvedValue(undefined)
    resetAppUpdateForTests({
      fetchDeployed: async () => null,
      navigate,
      purge,
      claimTimeoutMs: 20,
    })
    captureControllerChange()
    registerUpdateHandles(mockRegistration({ waiting }), vi.fn())

    await expect(applyWaitingUpdate()).resolves.toBe('updated')
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(purge).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(getUpdateDiagnostics().events.map((event) => event.phase)).toEqual([
      'apply-start',
      'claim',
      'purged-reload',
    ])
  })
})

describe('isRunningStale / stripUpdateNavigationMark', () => {
  afterEach(() => {
    resetAppUpdateForTests()
    const url = new URL(location.href)
    url.searchParams.delete(UPDATE_NAV_PARAM)
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  })

  it('never treats a local dev bundle as stale', () => {
    resetAppUpdateForTests({ runningSha: 'dev' })
    expect(isRunningStale({ commit: 'anything' })).toBe(false)
    expect(isRunningStale(null)).toBe(false)
  })

  it('detects a retired production shell', () => {
    resetAppUpdateForTests({ runningSha: 'old-sha' })
    expect(isRunningStale({ commit: 'new-sha' })).toBe(true)
    expect(isRunningStale({ commit: 'old-sha' })).toBe(false)
  })

  it('strips the one-shot update navigation mark', () => {
    const url = new URL(location.href)
    url.searchParams.set(UPDATE_NAV_PARAM, '1')
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    expect(new URL(location.href).searchParams.has(UPDATE_NAV_PARAM)).toBe(true)
    stripUpdateNavigationMark()
    expect(new URL(location.href).searchParams.has(UPDATE_NAV_PARAM)).toBe(false)
  })
})
