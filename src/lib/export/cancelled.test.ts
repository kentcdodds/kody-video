import { describe, expect, it } from 'vitest'
import {
  ExportCancelledError,
  decodedPumpFailure,
  isExportCancelled,
  throwIfExportAborted,
} from './cancelled'

describe('export cancellation', () => {
  it('throwIfExportAborted only throws when the signal is aborted', () => {
    const live = new AbortController()
    expect(() => throwIfExportAborted(live.signal)).not.toThrow()
    expect(() => throwIfExportAborted(undefined)).not.toThrow()
    live.abort()
    expect(() => throwIfExportAborted(live.signal)).toThrow(ExportCancelledError)
  })

  it('does not treat a pre-first-frame cancel as an unsupported codec', () => {
    expect(() => decodedPumpFailure(new ExportCancelledError(), 0)).toThrow(ExportCancelledError)
    expect(() => decodedPumpFailure(new ExportCancelledError(), 4)).toThrow(ExportCancelledError)
    expect(decodedPumpFailure(new Error('no track'), 0)).toBe('unsupported')
    expect(() => decodedPumpFailure(new Error('stalled'), 2)).toThrow(/stalled/)
  })

  it('recognizes AbortError as a cancel', () => {
    expect(isExportCancelled(new DOMException('aborted', 'AbortError'))).toBe(true)
    expect(isExportCancelled(new Error('nope'))).toBe(false)
  })
})
