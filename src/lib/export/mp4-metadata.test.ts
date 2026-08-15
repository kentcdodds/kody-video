import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'
import { describe, expect, it } from 'vitest'
import { commands } from 'vitest/browser'
import { formatIso6709, injectMp4Metadata, type Mp4Chapter } from './mp4-metadata'
import { KODY_VIDEO_ENCODER, KODY_VIDEO_SITE } from './mp4-export-metadata'

const AVC_DESC = new Uint8Array([
  0x01, 0x42, 0x00, 0x1e, 0xff, 0xe1, 0x00, 0x08, 0x67, 0x42, 0x00, 0x1e, 0xda, 0x02, 0xd0,
  0xf6, 0x01, 0x00, 0x04, 0x68, 0xce, 0x38, 0x80,
])

async function buildTinyMp4(): Promise<ArrayBuffer> {
  const target = new BufferTarget()
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target,
  })
  const source = new EncodedVideoPacketSource('avc')
  output.addVideoTrack(source)
  await output.start()
  const meta = {
    decoderConfig: {
      codec: 'avc1.42001e',
      codedWidth: 64,
      codedHeight: 64,
      description: AVC_DESC,
    },
  }
  await source.add(
    new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3]), 'key', 0, 0.033333),
    meta,
  )
  await source.add(
    new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x41, 1, 2, 3]), 'delta', 0.033333, 0.033333),
  )
  await output.finalize()
  if (!target.buffer) throw new Error('mux produced no buffer')
  return target.buffer
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>>
    0
  )
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8)
  return view.getBigUint64(0)
}

function fourCC(tag: string): number {
  return (
    (tag.charCodeAt(0) << 24) |
    (tag.charCodeAt(1) << 16) |
    (tag.charCodeAt(2) << 8) |
    tag.charCodeAt(3)
  ) >>> 0
}

interface Box {
  offset: number
  size: number
  type: number
  headerSize: number
}

function listBoxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = []
  let offset = start
  while (offset + 8 <= end) {
    let size = readU32(bytes, offset)
    const type = readU32(bytes, offset + 4)
    let headerSize = 8
    if (size === 1) {
      size = Number(readU64(bytes, offset + 8))
      headerSize = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < headerSize || offset + size > end) break
    boxes.push({ offset, size, type, headerSize })
    offset += size
  }
  return boxes
}

function findBox(bytes: Uint8Array, type: number, start = 0, end = bytes.byteLength): Box | null {
  return listBoxes(bytes, start, end).find((b) => b.type === type) ?? null
}

function readUdtaString(bytes: Uint8Array, box: Box): string {
  const payload = bytes.subarray(box.offset + box.headerSize, box.offset + box.size)
  const textLen = readU16(payload, 0)
  expect(readU16(payload, 2)).toBe(0x15c7)
  return new TextDecoder().decode(payload.subarray(4, 4 + textLen))
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

describe('injectMp4Metadata', () => {
  it('returns the buffer unchanged when there is nothing to inject', async () => {
    const src = await buildTinyMp4()
    const out = injectMp4Metadata(src, { chapters: [] })
    expect(new Uint8Array(out)).toEqual(new Uint8Array(src))
  })

  it('returns the buffer unchanged when moov is not the last top-level box', async () => {
    const src = new Uint8Array(await buildTinyMp4())
    const free = new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]) // 'free'
    const withTrailer = new Uint8Array(src.byteLength + free.byteLength)
    withTrailer.set(src, 0)
    withTrailer.set(free, src.byteLength)
    const out = injectMp4Metadata(withTrailer.buffer, {
      chapters: [{ startMs: 0, title: 'Nope' }],
      location: { lat: 1, lng: 2 },
    })
    expect(new Uint8Array(out)).toEqual(withTrailer)
  })

  it('appends udta/chpl/©xyz with ffmpeg-compatible bytes', async () => {
    const chapters: Mp4Chapter[] = [
      { startMs: 0, title: 'Clip One' },
      { startMs: 1500, title: 'Clip Two' },
    ]
    const location = { lat: 37.7749, lng: -122.4194 }
    const out = new Uint8Array(
      injectMp4Metadata(await buildTinyMp4(), { chapters, location }),
    )

    const moov = findBox(out, fourCC('moov'))
    expect(moov).not.toBeNull()
    expect(moov!.offset + moov!.size).toBe(out.byteLength)

    const udta = findBox(out, fourCC('udta'), moov!.offset + moov!.headerSize, moov!.offset + moov!.size)
    expect(udta).not.toBeNull()

    const chpl = findBox(out, fourCC('chpl'), udta!.offset + udta!.headerSize, udta!.offset + udta!.size)
    expect(chpl).not.toBeNull()
    const chplPayload = out.subarray(chpl!.offset + chpl!.headerSize, chpl!.offset + chpl!.size)
    expect(readU32(chplPayload, 0)).toBe(0x01000000) // version=1, flags=0
    expect(readU32(chplPayload, 4)).toBe(0) // reserved
    expect(chplPayload[8]).toBe(2)

    let o = 9
    const decoded: { start100ns: bigint; title: string }[] = []
    for (let i = 0; i < 2; i += 1) {
      const start100ns = readU64(chplPayload, o)
      o += 8
      const len = chplPayload[o]
      o += 1
      const title = new TextDecoder().decode(chplPayload.subarray(o, o + len))
      o += len
      decoded.push({ start100ns, title })
    }
    expect(decoded[0]).toEqual({ start100ns: 0n, title: 'Clip One' })
    expect(decoded[1]).toEqual({ start100ns: 15_000_000n, title: 'Clip Two' }) // 1500ms * 10_000

    const xyz = findBox(out, fourCC('\xa9xyz'), udta!.offset + udta!.headerSize, udta!.offset + udta!.size)
    expect(xyz).not.toBeNull()
    expect(readUdtaString(out, xyz!)).toBe(formatIso6709(37.7749, -122.4194))
    expect(readUdtaString(out, xyz!)).toBe('+37.7749-122.4194/')
  })

  it('appends title, description, comment, encoder, and date without requiring chapters', async () => {
    const out = new Uint8Array(
      injectMp4Metadata(await buildTinyMp4(), {
        chapters: [],
        title: 'Beach day',
        description: `3 clips · 24s\nMade with Kody Video — ${KODY_VIDEO_SITE}`,
        comment: '3 clips · 24s · kody.video',
        encoder: KODY_VIDEO_ENCODER,
        date: '2026-08-08',
      }),
    )
    const moov = findBox(out, fourCC('moov'))
    const udta = findBox(out, fourCC('udta'), moov!.offset + moov!.headerSize, moov!.offset + moov!.size)
    expect(udta).not.toBeNull()
    const start = udta!.offset + udta!.headerSize
    const end = udta!.offset + udta!.size
    expect(readUdtaString(out, findBox(out, fourCC('\xa9nam'), start, end)!)).toBe('Beach day')
    expect(readUdtaString(out, findBox(out, fourCC('\xa9cmt'), start, end)!)).toBe(
      '3 clips · 24s · kody.video',
    )
    expect(readUdtaString(out, findBox(out, fourCC('\xa9too'), start, end)!)).toBe(KODY_VIDEO_ENCODER)
    expect(readUdtaString(out, findBox(out, fourCC('\xa9day'), start, end)!)).toBe('2026-08-08')
    expect(readUdtaString(out, findBox(out, fourCC('\xa9des'), start, end)!)).toContain(KODY_VIDEO_SITE)
    expect(findBox(out, fourCC('\xa9xyz'), start, end)).toBeNull()
    expect(findBox(out, fourCC('chpl'), start, end)).toBeNull()
  })

  it('is validated by ffmpeg when an MP4-capable binary is available', async () => {
    const title = 'Morning Walk'
    const location = { lat: 37.7749, lng: -122.4194 }
    const injected = injectMp4Metadata(await buildTinyMp4(), {
      chapters: [
        { startMs: 0, title },
        { startMs: 2000, title: 'Later' },
      ],
      location,
      title: 'Beach day',
      comment: '2 clips · 4s · kody.video',
      encoder: KODY_VIDEO_ENCODER,
    })

    // ffmpeg runs on the Vitest server (Node), not in the browser — see
    // src/test/ffmpeg-command.ts.
    const stderr = await commands.probeMp4WithFfmpeg(toBase64(injected))
    if (stderr === null) {
      // No MP4-capable ffmpeg on the server; skip rather than fail.
      return
    }
    expect(stderr).toMatch(/Chapters/i)
    expect(stderr).toContain(title)
    expect(stderr).toMatch(/\+37\.7749-122\.4194\//)
    expect(stderr).toContain('kody.video')
    expect(stderr).toContain('Beach day')
  })
})

describe('formatIso6709', () => {
  it('always includes signs, pads longitude, and ends with a slash', () => {
    expect(formatIso6709(41.3758, 2.1492)).toBe('+41.3758+002.1492/')
    expect(formatIso6709(-33.8688, -151.2093)).toBe('-33.8688-151.2093/')
  })
})
