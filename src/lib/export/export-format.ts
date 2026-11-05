import { getFirstEncodableAudioCodec, getFirstEncodableVideoCodec } from 'mediabunny'
import { isIosBrowser } from '../platform'
import type { ExportFormat } from '../types'

export const EXPORT_FORMAT_IDS = ['mp4', 'webm'] as const satisfies readonly ExportFormat[]

export const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = {
  mp4: 'MP4',
  webm: 'WebM',
}

export const EXPORT_FORMAT_HINT: Record<ExportFormat, string> = {
  mp4: 'H.264 + AAC — plays on iPhone, Photos, and every share target',
  webm: 'VP9 + Opus — open format; iPhone and many apps can’t play it',
}

export const EXPORT_FORMAT_UNAVAILABLE: Record<ExportFormat, string> = {
  mp4: 'This browser can’t encode H.264, so exports are WebM.',
  webm: 'WebM isn’t available here, so exports are MP4.',
}

export type ExportFormatSupport = Record<ExportFormat, boolean>

let aacEncoderRegistration: Promise<boolean> | null = null

/**
 * Browsers with an H.264 encoder but no native AAC encoder (Chrome on
 * Linux, Firefox) would otherwise drop to WebM. Mediabunny's WASM AAC-LC
 * encoder fills that gap; it's loaded only when actually needed.
 */
export function ensureAacEncoder(): Promise<boolean> {
  aacEncoderRegistration ??= import('@mediabunny/aac-encoder').then(
    ({ registerAacEncoder }) => {
      registerAacEncoder()
      return true
    },
    (error: unknown) => {
      console.warn('AAC encoder failed to load', error)
      aacEncoderRegistration = null
      return false
    },
  )
  return aacEncoderRegistration
}

const AUDIO_CONFIG = { numberOfChannels: 2, sampleRate: 48000 }

/** First encodable MP4 audio codec, registering the WASM AAC fallback when needed. */
export async function encodableMp4Audio(): Promise<'aac' | null> {
  if (await getFirstEncodableAudioCodec(['aac'], AUDIO_CONFIG)) return 'aac'
  if (typeof WebAssembly === 'undefined' || !(await ensureAacEncoder())) return null
  return (await getFirstEncodableAudioCodec(['aac'], AUDIO_CONFIG)) ? 'aac' : null
}

let supportProbe: Promise<ExportFormatSupport> | null = null

/** Which containers this browser can export (probed once per session). */
export function probeExportFormats(): Promise<ExportFormatSupport> {
  supportProbe ??= detectExportFormats().catch(() => ({ mp4: true, webm: !isIosBrowser() }))
  return supportProbe
}

async function detectExportFormats(): Promise<ExportFormatSupport> {
  const size = { width: 1280, height: 720 }
  if (typeof VideoEncoder !== 'undefined') {
    const mp4 = (await getFirstEncodableVideoCodec(['avc', 'hevc'], size)) !== null
    const webm =
      !isIosBrowser() &&
      (await getFirstEncodableVideoCodec(['vp9', 'vp8'], size)) !== null &&
      (await getFirstEncodableAudioCodec(['opus'], AUDIO_CONFIG)) !== null
    // AAC comes from the WASM encoder when the browser has none.
    if (mp4 || webm) return { mp4: mp4 && typeof WebAssembly !== 'undefined', webm }
  }
  const recorder = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null
  return {
    mp4: recorder?.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2') ?? false,
    webm: !isIosBrowser() && (recorder?.isTypeSupported('video/webm') ?? false),
  }
}

/** The container an export will actually use for the remembered preference. */
export function effectiveExportFormat(
  preferred: ExportFormat,
  support: ExportFormatSupport | null,
): ExportFormat {
  if (!support || support[preferred]) return preferred
  const other: ExportFormat = preferred === 'mp4' ? 'webm' : 'mp4'
  return support[other] ? other : preferred
}
