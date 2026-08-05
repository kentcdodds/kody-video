import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resetMicMonitorForTests,
  startMicLevelMonitor,
  warmMicMonitorContext,
} from './mic-monitor'

// The monitor shares one AudioContext at module scope;
// resetMicMonitorForTests drops it between tests — the browser module graph
// cannot be re-imported per test the way vi.resetModules allowed in Node.

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

afterEach(() => {
  vi.unstubAllGlobals()
  resetMicMonitorForTests()
  FakeAudioContext.constructed = 0
})

describe('warmMicMonitorContext', () => {
  it('creates the shared context once, suspended, and takes reuse it', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('MediaStream', FakeMediaStream)

    warmMicMonitorContext()
    warmMicMonitorContext()
    expect(FakeAudioContext.constructed).toBe(1)

    // A take starting later must reuse the pre-warmed context instead of
    // constructing a second one on the record-start critical path.
    const stream = new FakeMediaStream([liveTrack()]) as unknown as MediaStream
    const handle = startMicLevelMonitor(stream, {
      onSilent: () => undefined,
      onSound: () => undefined,
    })
    expect(FakeAudioContext.constructed).toBe(1)
    handle.stop()
  })

  it('is a no-op when AudioContext is unavailable', () => {
    // The browser has a real AudioContext — hide it for this test.
    vi.stubGlobal('AudioContext', undefined)
    expect(() => warmMicMonitorContext()).not.toThrow()
  })
})
