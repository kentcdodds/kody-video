import { describe, expect, it } from 'vitest'
import {
  isBrowserExtensionHostObjectNoiseEvent,
  isChunkLoadErrorEvent,
  isCloudflareInsightsBeaconEvent,
  isExpectedUserError,
  isMonitoringSelfTestEvent,
  isProjectLimitEvent,
  isReportingHostname,
  isTranslatorDomMutationNoiseEvent,
  isViteCssPreloadError,
  reportComponentError,
  reportError,
} from './error-reporting'
import { ProjectLimitError } from './storage'

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

describe('isProjectLimitEvent', () => {
  it('drops ProjectLimitError by exception type', () => {
    expect(
      isProjectLimitEvent({
        exception: {
          values: [
            {
              type: 'ProjectLimitError',
              value: 'The free plan includes 1 project — Kody Video Plus unlocks 6.',
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('drops the free-plan copy even when typed as Error (pre-fix events)', () => {
    expect(
      isProjectLimitEvent({
        exception: {
          values: [
            {
              type: 'Error',
              value:
                'The free plan includes 1 project — Kody Video Plus unlocks 6 (and removes the watermark).',
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('drops the hard project-cap copy', () => {
    expect(
      isProjectLimitEvent({
        exception: {
          values: [
            {
              type: 'Error',
              value: 'Project limit reached (6). Delete a project to create another.',
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('keeps unrelated application errors', () => {
    expect(
      isProjectLimitEvent({
        exception: {
          values: [{ type: 'Error', value: 'Export failed: encoder closed' }],
        },
      }),
    ).toBe(false)
  })
})

describe('isExpectedUserError / reportError', () => {
  it('recognizes ProjectLimitError instances', () => {
    expect(isExpectedUserError(new ProjectLimitError('capped'))).toBe(true)
    expect(isExpectedUserError(new Error('Export failed'))).toBe(false)
  })

  it('reportError returns without throwing for ProjectLimitError', () => {
    // Short-circuits before the idle-deferred SDK load — no capture queued.
    expect(() =>
      reportError(new ProjectLimitError('The free plan includes 1 project'), 'save-clip'),
    ).not.toThrow()
  })
})

describe('isReportingHostname / local capture paths', () => {
  it('allows only production deployment hostnames', () => {
    expect(isReportingHostname('kody.video')).toBe(true)
    expect(isReportingHostname('kody-video.pages.dev')).toBe(true)
    expect(isReportingHostname('localhost')).toBe(false)
    expect(isReportingHostname('127.0.0.1')).toBe(false)
    expect(isReportingHostname('example.com')).toBe(false)
  })

  it('reportError and reportComponentError stay silent off reporting hosts', () => {
    // Vitest runs on localhost — these must not load Sentry or throw.
    expect(() => reportError(new Error('Vite HMR glitch'), 'import')).not.toThrow()
    expect(() =>
      reportComponentError(new ReferenceError('importProgress is not defined')),
    ).not.toThrow()
  })
})

describe('isBrowserExtensionHostObjectNoiseEvent', () => {
  it('drops the classic host-bridge Object Not Found rejection (KODY-VIDEO-H)', () => {
    expect(
      isBrowserExtensionHostObjectNoiseEvent({
        exception: {
          values: [
            {
              type: 'UnhandledRejection',
              value:
                'Non-Error promise rejection captured with value: Object Not Found Matching Id:1, MethodName:update, ParamCount:4',
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('drops when the signature appears only in message', () => {
    expect(
      isBrowserExtensionHostObjectNoiseEvent({
        message: 'Object Not Found Matching Id:2, MethodName:update, ParamCount:4',
      }),
    ).toBe(true)
  })

  it('keeps ordinary application errors', () => {
    expect(
      isBrowserExtensionHostObjectNoiseEvent({
        exception: {
          values: [{ type: 'Error', value: 'Export failed: encoder closed' }],
        },
      }),
    ).toBe(false)
  })

  it('keeps unrelated Object Not Found wording without the host-bridge shape', () => {
    expect(
      isBrowserExtensionHostObjectNoiseEvent({
        exception: {
          values: [
            {
              type: 'NotFoundError',
              value: 'The object can not be found here.',
            },
          ],
        },
      }),
    ).toBe(false)
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

describe('isViteCssPreloadError', () => {
  it('drops Vite CSS preload helper failures for hashed assets', () => {
    expect(
      isViteCssPreloadError({
        exception: {
          values: [
            {
              type: 'Error',
              value: 'Unable to preload CSS for /assets/fonts-CbakDoPd.css',
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('drops when the signature appears only in message', () => {
    expect(
      isViteCssPreloadError({
        message: 'Unable to preload CSS for /assets/home-abc123.css',
      }),
    ).toBe(true)
  })

  it('keeps ordinary application errors', () => {
    expect(
      isViteCssPreloadError({
        exception: {
          values: [{ type: 'Error', value: 'Export failed: encoder closed' }],
        },
      }),
    ).toBe(false)
  })

  it('keeps unrelated preload wording', () => {
    expect(
      isViteCssPreloadError({
        exception: {
          values: [
            { type: 'Error', value: 'Unable to preload image for /assets/hero.webp' },
          ],
        },
      }),
    ).toBe(false)
  })
})

describe('isChunkLoadErrorEvent', () => {
  it('drops Safari / WebKit module script import failures (KODY-VIDEO-S)', () => {
    expect(
      isChunkLoadErrorEvent({
        exception: {
          values: [
            {
              type: 'TypeError',
              value: 'Importing a module script failed.',
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('drops Chromium / Vite dynamic import failures (KODY-VIDEO-G)', () => {
    expect(
      isChunkLoadErrorEvent({
        exception: {
          values: [
            {
              type: 'TypeError',
              value:
                'Failed to fetch dynamically imported module: https://kody.video/assets/project-page-ZRp-szjZ.js',
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('drops webpack-style and alternate dynamic-import wording', () => {
    expect(
      isChunkLoadErrorEvent({
        exception: {
          values: [{ type: 'Error', value: 'Loading chunk 5 failed' }],
        },
      }),
    ).toBe(true)
    expect(
      isChunkLoadErrorEvent({
        message: 'error loading dynamically imported module',
      }),
    ).toBe(true)
  })

  it('keeps ordinary application errors', () => {
    expect(
      isChunkLoadErrorEvent({
        exception: {
          values: [{ type: 'Error', value: 'Export failed: encoder closed' }],
        },
      }),
    ).toBe(false)
  })
})

describe('isTranslatorDomMutationNoiseEvent', () => {
  it('drops Chromium removeChild NotFoundError with mutation stack (KCD-S5 class)', () => {
    expect(
      isTranslatorDomMutationNoiseEvent({
        exception: {
          values: [
            {
              type: 'NotFoundError',
              value:
                "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
              stacktrace: {
                frames: [
                  {
                    filename: '/assets/index-abc123.js',
                    function: 'removeChild',
                    in_app: false,
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('drops Safari Translate NotFoundError with empty stack (KODY-VIDEO-D)', () => {
    expect(
      isTranslatorDomMutationNoiseEvent({
        exception: {
          values: [
            {
              type: 'NotFoundError',
              value: 'The object can not be found here.',
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('drops Safari NotFoundError with native removeChild frame (KCD-ZE class)', () => {
    expect(
      isTranslatorDomMutationNoiseEvent({
        exception: {
          values: [
            {
              type: 'NotFoundError',
              value: 'The object can not be found here.',
              stacktrace: {
                frames: [
                  {
                    filename: '[native code]',
                    function: 'removeChild',
                    in_app: false,
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('keeps intentional reportError captures tagged with step', () => {
    expect(
      isTranslatorDomMutationNoiseEvent({
        tags: { step: 'export-audio' },
        exception: {
          values: [
            {
              type: 'NotFoundError',
              value: 'The object can not be found here.',
            },
          ],
        },
      }),
    ).toBe(false)
  })

  it('keeps in-app DOM bugs that happen to share the message', () => {
    expect(
      isTranslatorDomMutationNoiseEvent({
        exception: {
          values: [
            {
              type: 'NotFoundError',
              value:
                "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
              stacktrace: {
                frames: [
                  {
                    filename: '/assets/project-page-abc.js',
                    function: 'trimClip',
                    in_app: true,
                  },
                  {
                    filename: '[native code]',
                    function: 'removeChild',
                    in_app: false,
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(false)
  })

  it('keeps ordinary application errors', () => {
    expect(
      isTranslatorDomMutationNoiseEvent({
        exception: {
          values: [{ type: 'Error', value: 'Export failed: encoder closed' }],
        },
      }),
    ).toBe(false)
  })

  it('keeps unrelated NotFoundError wording', () => {
    expect(
      isTranslatorDomMutationNoiseEvent({
        exception: {
          values: [
            {
              type: 'NotFoundError',
              value: 'Requested device not found',
            },
          ],
        },
      }),
    ).toBe(false)
  })
})
