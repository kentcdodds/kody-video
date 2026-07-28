import { describe, expect, it } from 'vitest'
import {
  isCloudflareInsightsBeaconEvent,
  isMonitoringSelfTestEvent,
} from './error-reporting'

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

describe('isCloudflareInsightsBeaconEvent', () => {
  const beaconFrame = {
    filename: '/beacon.min.js/v4513226cdae34746b4dedf0b4dfa099e1781791509496',
    abs_path:
      'https://static.cloudflareinsights.com/beacon.min.js/v4513226cdae34746b4dedf0b4dfa099e1781791509496',
  }

  it('drops events whose stack is only Cloudflare Insights beacon frames', () => {
    expect(
      isCloudflareInsightsBeaconEvent({
        exception: {
          values: [
            {
              type: 'TypeError',
              value: 't.entries.at is not a function',
              stacktrace: { frames: [beaconFrame, beaconFrame] },
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('matches abs_path or filename containing the beacon host path', () => {
    expect(
      isCloudflareInsightsBeaconEvent({
        exception: {
          values: [
            {
              type: 'TypeError',
              value: 'this.i.at is not a function',
              stacktrace: {
                frames: [
                  {
                    filename:
                      'https://static.cloudflareinsights.com/beacon.min.js/v1',
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('keeps mixed stacks that include application frames', () => {
    expect(
      isCloudflareInsightsBeaconEvent({
        exception: {
          values: [
            {
              type: 'TypeError',
              value: 't.entries.at is not a function',
              stacktrace: {
                frames: [
                  beaconFrame,
                  { filename: '/assets/index-abc123.js', abs_path: undefined },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(false)
  })

  it('keeps ordinary application errors with no beacon frames', () => {
    expect(
      isCloudflareInsightsBeaconEvent({
        exception: {
          values: [
            {
              type: 'Error',
              value: 'Export failed: encoder closed',
              stacktrace: {
                frames: [{ filename: '/assets/index-abc123.js' }],
              },
            },
          ],
        },
      }),
    ).toBe(false)
  })

  it('keeps events with no stack frames', () => {
    expect(
      isCloudflareInsightsBeaconEvent({
        exception: {
          values: [{ type: 'TypeError', value: 't.entries.at is not a function' }],
        },
      }),
    ).toBe(false)
  })
})
