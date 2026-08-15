export interface Mp4Chapter {
  startMs: number
  title: string
}

export interface Mp4MetadataInput {
  chapters: Mp4Chapter[]
  location?: { lat: number; lng: number } | null
  title?: string
  description?: string
  comment?: string
  encoder?: string
  /** `YYYY-MM-DD` filming/creation date (omit for public shares). */
  date?: string
}

const TYPE_MOOV = fourCC('moov')
const TYPE_UDTA = fourCC('udta')
const TYPE_CHPL = fourCC('chpl')
const TYPE_XYZ = fourCC('\xa9xyz')
const TYPE_NAM = fourCC('\xa9nam')
const TYPE_DES = fourCC('\xa9des')
const TYPE_CMT = fourCC('\xa9cmt')
const TYPE_TOO = fourCC('\xa9too')
const TYPE_DAY = fourCC('\xa9day')

/**
 * Append Nero chapters (`chpl`), QuickTime text tags (`©nam` / `©des` /
 * `©cmt` / `©too` / `©day`), and/or a `©xyz` geotag under `moov/udta`.
 * Only safe when `moov` is the last top-level box (trailing moov / no
 * faststart) — otherwise returns the input unchanged.
 */
export function injectMp4Metadata(buffer: ArrayBuffer, input: Mp4MetadataInput): ArrayBuffer {
  try {
    return injectMp4MetadataInner(buffer, input)
  } catch {
    return buffer
  }
}

function injectMp4MetadataInner(buffer: ArrayBuffer, input: Mp4MetadataInput): ArrayBuffer {
  const hasChapters = input.chapters.length > 0
  const location = input.location ?? null
  const title = optionalText(input.title)
  const description = optionalText(input.description)
  const comment = optionalText(input.comment)
  const encoder = optionalText(input.encoder)
  const date = optionalText(input.date)
  if (!hasChapters && !location && !title && !description && !comment && !encoder && !date) {
    return buffer
  }

  const bytes = new Uint8Array(buffer)
  const top = listTopLevelBoxes(bytes)
  if (top.length === 0) return buffer

  const moovIndex = top.findIndex((b) => b.type === TYPE_MOOV)
  if (moovIndex < 0) return buffer

  // Appending inside a non-trailing moov would shift mdat and invalidate
  // chunk offsets — refuse rather than rewrite stco/co64.
  if (moovIndex !== top.length - 1) return buffer

  const moov = top[moovIndex]
  if (moov.size > 0xffff_ffff - 8) return buffer

  const children: Uint8Array[] = []
  if (hasChapters) children.push(buildChplBox(input.chapters))
  if (title) children.push(buildUdtaStringBox(TYPE_NAM, title))
  if (description) children.push(buildUdtaStringBox(TYPE_DES, description))
  if (comment) children.push(buildUdtaStringBox(TYPE_CMT, comment))
  if (encoder) children.push(buildUdtaStringBox(TYPE_TOO, encoder))
  if (date) children.push(buildUdtaStringBox(TYPE_DAY, date))
  if (location) children.push(buildXyzBox(location.lat, location.lng))
  if (children.length === 0) return buffer

  const udta = wrapBox(TYPE_UDTA, concat(children))
  const newMoovSize = moov.size + udta.byteLength
  if (newMoovSize > 0xffff_ffff) return buffer

  const out = new Uint8Array(bytes.byteLength + udta.byteLength)
  out.set(bytes, 0)
  writeU32(out, moov.offset, newMoovSize)
  out.set(udta, bytes.byteLength)
  return out.buffer
}

/**
 * Nero `chpl` layout matching ffmpeg's `mov_write_chpl_tag`:
 *   fullbox version=1 flags=0, u32 reserved=0, u8 count,
 *   then per chapter: u64 start (100 ns units), u8 titleLen, UTF-8 title.
 */
function buildChplBox(chapters: Mp4Chapter[]): Uint8Array {
  const entries = chapters.slice(0, 255).map((ch) => {
    const titleBytes = truncateUtf8(ch.title, 255)
    const start100ns = Math.max(0, Math.round(ch.startMs * 10_000))
    return { start100ns, titleBytes }
  })

  let payloadLen = 4 /* version+flags */ + 4 /* reserved */ + 1 /* count */
  for (const e of entries) payloadLen += 8 + 1 + e.titleBytes.byteLength

  const payload = new Uint8Array(payloadLen)
  const view = new DataView(payload.buffer)
  view.setUint32(0, 0x01000000) // version=1, flags=0
  view.setUint32(4, 0) // reserved / unknown (ffmpeg writes 0)
  payload[8] = entries.length
  let o = 9
  for (const e of entries) {
    view.setBigUint64(o, BigInt(e.start100ns))
    o += 8
    payload[o] = e.titleBytes.byteLength
    o += 1
    payload.set(e.titleBytes, o)
    o += e.titleBytes.byteLength
  }
  return wrapBox(TYPE_CHPL, payload)
}

/** QuickTime `©xyz`: u16 length, u16 language 0x15c7 (eng), ISO 6709 string. */
function buildXyzBox(lat: number, lng: number): Uint8Array {
  return buildUdtaStringBox(TYPE_XYZ, formatIso6709(lat, lng))
}

/** QuickTime user-data text: u16 length, u16 language 0x15c7 (eng), UTF-8. */
function buildUdtaStringBox(type: number, text: string): Uint8Array {
  const textBytes = truncateUtf8(text, 0xffff)
  const payload = new Uint8Array(4 + textBytes.byteLength)
  const view = new DataView(payload.buffer)
  view.setUint16(0, textBytes.byteLength)
  view.setUint16(2, 0x15c7)
  payload.set(textBytes, 4)
  return wrapBox(type, payload)
}

function optionalText(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed ? trimmed : null
}

/** `+DD.DDDD+DDD.DDDD/` (signs always present, 4 decimal places). */
export function formatIso6709(lat: number, lng: number): string {
  return `${formatIsoCoord(lat, 2)}${formatIsoCoord(lng, 3)}/`
}

function formatIsoCoord(value: number, intWidth: number): string {
  const sign = value >= 0 && !Object.is(value, -0) ? '+' : '-'
  const [intPart, frac = '0000'] = Math.abs(value).toFixed(4).split('.')
  return `${sign}${intPart.padStart(intWidth, '0')}.${frac}`
}

interface BoxInfo {
  offset: number
  size: number
  type: number
  headerSize: number
}

function listTopLevelBoxes(bytes: Uint8Array): BoxInfo[] {
  const boxes: BoxInfo[] = []
  let offset = 0
  while (offset + 8 <= bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset)
    let size = view.getUint32(0)
    const type = view.getUint32(4)
    let headerSize = 8
    if (size === 1) {
      if (offset + 16 > bytes.byteLength) break
      // Large-size boxes are unused by our muxer; treat as unreadable.
      const large = Number(view.getBigUint64(8))
      if (!Number.isSafeInteger(large) || large < 16) break
      size = large
      headerSize = 16
    } else if (size === 0) {
      size = bytes.byteLength - offset
    }
    if (size < headerSize || offset + size > bytes.byteLength) break
    boxes.push({ offset, size, type, headerSize })
    offset += size
  }
  return boxes
}

function wrapBox(type: number, payload: Uint8Array): Uint8Array {
  const size = 8 + payload.byteLength
  if (size > 0xffff_ffff) throw new Error('box too large')
  const out = new Uint8Array(size)
  writeU32(out, 0, size)
  writeU32(out, 4, type)
  out.set(payload, 8)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.byteLength
  }
  return out
}

function truncateUtf8(text: string, maxBytes: number): Uint8Array {
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= maxBytes) return encoded
  let end = maxBytes
  // Avoid splitting a multi-byte UTF-8 sequence.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1
  return encoded.subarray(0, end)
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

function fourCC(tag: string): number {
  return (
    (tag.charCodeAt(0) << 24) |
    (tag.charCodeAt(1) << 16) |
    (tag.charCodeAt(2) << 8) |
    tag.charCodeAt(3)
  ) >>> 0
}
