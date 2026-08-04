import { afterEach, describe, expect, it, vi } from 'vitest'

// The monitor shares one AudioContext at module scope, so each test
// re-imports a fresh module instance via vi.resetModules — a top-level
// import would leak the shared context between tests.

class FakeAnalyser {
  fftSize = 0
  disconnect(): void {}
  getFloatTimeDomainData(): void {}
}

class FakeSource {
  connect(): void {}
  disconnect(): void {}
}

class FakeAudioContext {
  static constructed = 0
  state: 'suspended' | 'running' = 'suspended'
  constructor() {
    FakeAudioContext.constructed += 1
  }
  suspend(): Promise<void> {
    this.state = 'suspended'
    return Promise.resolve()
  }
  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }
  createMediaStreamSource(): FakeSource {
    return new FakeSource()
  }
  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser()
  }
}

class FakeMediaStream {
  private tracks: unknown[]
  constructor(tracks: unknown[] = []) {
    this.tracks = tracks
  }
  getAudioTracks(): unknown[] {
    return this.tracks
  }
}

const liveTrack = () => ({
  kind: 'audio',
  readyState: 'live',
  addEventListener: () => undefined,
})

async function freshMicMonitor() {
  vi.resetModules()
  return import('./mic-monitor')
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeAudioContext.constructed = 0
})

describe('warmMicMonitorContext', () => {
  it('creates the shared context once, suspended, and takes reuse it', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('MediaStream', FakeMediaStream)
    vi.stubGlobal('window', globalThis)
    const monitor = await freshMicMonitor()

    monitor.warmMicMonitorContext()
    monitor.warmMicMonitorContext()
    expect(FakeAudioContext.constructed).toBe(1)

    // A take starting later must reuse the pre-warmed context instead of
    // constructing a second one on the record-start critical path.
    const stream = new FakeMediaStream([liveTrack()]) as unknown as MediaStream
    const handle = monitor.startMicLevelMonitor(stream, {
      onSilent: () => undefined,
      onSound: () => undefined,
    })
    expect(FakeAudioContext.constructed).toBe(1)
    handle.stop()
  })

  it('is a no-op when AudioContext is unavailable', async () => {
    const monitor = await freshMicMonitor()
    expect(() => monitor.warmMicMonitorContext()).not.toThrow()
  })
})
