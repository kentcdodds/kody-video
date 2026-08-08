import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listAudioInputs,
  rememberAudioInput,
  rememberedAudioInput,
  resolveAudioInput,
  resolvePreferredAudioInputId,
} from './audio-input'

function device(kind: MediaDeviceKind, deviceId: string, label = ''): MediaDeviceInfo {
  return {
    kind,
    deviceId,
    label,
    groupId: `group-${deviceId}`,
    toJSON() {
      return { kind, deviceId, label }
    },
  } as MediaDeviceInfo
}

function stubEnumerate(devices: MediaDeviceInfo[]): void {
  vi.spyOn(navigator.mediaDevices, 'enumerateDevices').mockResolvedValue(devices)
}

afterEach(() => {
  vi.restoreAllMocks()
  rememberAudioInput(null)
})

describe('listAudioInputs', () => {
  it('returns only audio inputs with real device ids', async () => {
    stubEnumerate([
      device('videoinput', 'cam-1', 'Back Camera'),
      device('audioinput', 'mic-1', 'Built-in Microphone'),
      device('audioinput', '', ''),
      device('audiooutput', 'speaker-1', 'Speakers'),
      device('audioinput', 'mic-2', 'USB Microphone'),
    ])
    expect(await listAudioInputs()).toEqual([
      { id: 'mic-1', label: 'Built-in Microphone' },
      { id: 'mic-2', label: 'USB Microphone' },
    ])
  })

  it("drops Chrome's default/communications aliases when physical mics exist", async () => {
    stubEnumerate([
      device('audioinput', 'default', 'Default - USB Microphone'),
      device('audioinput', 'communications', 'Communications - USB Microphone'),
      device('audioinput', 'mic-1', 'USB Microphone'),
      device('audioinput', 'mic-2', 'Headset Microphone'),
    ])
    expect(await listAudioInputs()).toEqual([
      { id: 'mic-1', label: 'USB Microphone' },
      { id: 'mic-2', label: 'Headset Microphone' },
    ])
  })

  it('keeps the aliases when they are the only entries', async () => {
    stubEnumerate([device('audioinput', 'default', 'Default')])
    expect(await listAudioInputs()).toEqual([{ id: 'default', label: 'Default' }])
  })

  it('returns empty on enumeration failure', async () => {
    vi.spyOn(navigator.mediaDevices, 'enumerateDevices').mockRejectedValue(
      new Error('enumeration failed'),
    )
    expect(await listAudioInputs()).toEqual([])
  })
})

describe('remembered audio input', () => {
  it('round-trips through localStorage and clears on null', () => {
    expect(rememberedAudioInput()).toBeNull()
    rememberAudioInput({ id: 'mic-1', label: 'USB Microphone' })
    expect(rememberedAudioInput()).toEqual({ id: 'mic-1', label: 'USB Microphone' })
    rememberAudioInput(null)
    expect(rememberedAudioInput()).toBeNull()
  })

  it('ignores malformed stored values', () => {
    localStorage.setItem('kodyVideo.audioInput', '{"id":42}')
    expect(rememberedAudioInput()).toBeNull()
  })
})

describe('resolveAudioInput', () => {
  const inputs = [
    { id: 'mic-1', label: 'Built-in Microphone' },
    { id: 'mic-2', label: 'USB Microphone' },
  ]

  it('is undefined when nothing was chosen', () => {
    expect(resolveAudioInput(inputs)).toBeUndefined()
  })

  it('prefers the exact remembered id', () => {
    rememberAudioInput({ id: 'mic-2', label: 'USB Microphone' })
    expect(resolveAudioInput(inputs)).toBe('mic-2')
  })

  it('re-matches by label when the id rotated (site-data clear)', () => {
    rememberAudioInput({ id: 'old-rotated-id', label: 'USB Microphone' })
    expect(resolveAudioInput(inputs)).toBe('mic-2')
  })

  it('falls back to the default (undefined) when the mic is unplugged', () => {
    rememberAudioInput({ id: 'bt-mic', label: 'Bluetooth Microphone' })
    expect(resolveAudioInput(inputs)).toBeUndefined()
    // The choice stays remembered so a reconnected mic wins again.
    expect(rememberedAudioInput()).toEqual({ id: 'bt-mic', label: 'Bluetooth Microphone' })
  })

  it('never matches by an empty label', () => {
    rememberAudioInput({ id: 'gone', label: '' })
    expect(
      resolveAudioInput([
        { id: 'mic-3', label: '' },
        { id: 'mic-4', label: '' },
      ]),
    ).toBeUndefined()
  })
})

describe('resolvePreferredAudioInputId', () => {
  it('skips enumeration entirely when nothing was chosen', async () => {
    const spy = vi.spyOn(navigator.mediaDevices, 'enumerateDevices')
    expect(await resolvePreferredAudioInputId()).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  it('enumerates and resolves a remembered mic', async () => {
    stubEnumerate([device('audioinput', 'mic-1', 'USB Microphone')])
    rememberAudioInput({ id: 'mic-1', label: 'USB Microphone' })
    expect(await resolvePreferredAudioInputId()).toBe('mic-1')
  })
})
