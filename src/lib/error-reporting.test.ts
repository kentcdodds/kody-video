import { describe, expect, it } from 'vitest'
import { isMonitoringSelfTestEvent } from './error-reporting'

describe('isMonitoringSelfTestEvent', () => {
  it('drops the setup-agent synthetic exception signature', () => {
    expect(
      isMonitoringSelfTestEvent({
        exception: {
          values: [
            {
              type: 'Error',
              value:
                'KodyVideoMonitoringSelfTest: synthetic uncaught error from the setup agent',
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('drops when the marker appears only in message', () => {
    expect(
      isMonitoringSelfTestEvent({
        message: 'KodyVideoMonitoringSelfTest: synthetic uncaught error',
      }),
    ).toBe(true)
  })

  it('keeps ordinary application errors', () => {
    expect(
      isMonitoringSelfTestEvent({
        exception: {
          values: [{ type: 'Error', value: 'Export failed: encoder closed' }],
        },
      }),
    ).toBe(false)
  })

  it('keeps events with no exception payload', () => {
    expect(isMonitoringSelfTestEvent({})).toBe(false)
  })
})
