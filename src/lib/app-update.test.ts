import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkForUpdates,
  probeForUpdates,
  registerUpdateHandles,
  resetAppUpdateForTests,
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
    resetAppUpdateForTests({ minIntervalMs: 1_000 })
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
})

describe('checkForUpdates (manual)', () => {
  beforeEach(() => {
    resetAppUpdateForTests()
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
})
