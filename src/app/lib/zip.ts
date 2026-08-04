/**
 * Minimal streaming ZIP writer (store mode, no compression) — a vanilla
 * replacement for the `client-zip` dependency. Clips are already-compressed
 * video, so storing them uncompressed is exactly right, and streaming means
 * gigabyte projects never sit fully in RAM.
 *
 * Classic 32-bit ZIP with data descriptors (general-purpose bit 3) and
 * UTF-8 names (bit 11). Archives beyond the 4 GiB / 65k-entry limits of the
 * classic format are rejected up front rather than corrupted.
 */

export interface ZipEntry {
  name: string
  lastModified?: Date
  input: Blob
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

function crc32(crc: number, bytes: Uint8Array): number {
  let c = crc ^ 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS date/time pair (ZIP's native timestamp format). */
function dosDateTime(date: Date): { time: number; day: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day =
    (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time: time & 0xffff, day: day & 0xffff }
}

const CLASSIC_ZIP_MAX_BYTES = 0xffffffff

interface CentralRecord {
  nameBytes: Uint8Array
  time: number
  day: number
  crc: number
  size: number
  headerOffset: number
}

/**
 * Build a ZIP from entries (input: Blob). Returns a ReadableStream of
 * Uint8Array chunks.
 */
export function makeZip(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  if (entries.length > 0xffff) {
    throw new Error(`Too many files for a ZIP archive (${entries.length})`)
  }
  const totalInputBytes = entries.reduce((sum, entry) => sum + entry.input.size, 0)
  if (totalInputBytes > CLASSIC_ZIP_MAX_BYTES) {
    throw new Error('Project is too large for a single ZIP archive (4 GB limit)')
  }

  const encoder = new TextEncoder()
  const central: CentralRecord[] = []
  let offset = 0
  let index = 0

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < entries.length) {
        const entry = entries[index]!
        index += 1
        const nameBytes = encoder.encode(entry.name)
        const { time, day } = dosDateTime(entry.lastModified ?? new Date())
        const headerOffset = offset

        // Local file header. Sizes/CRC are zero here (streamed) and follow
        // in the data descriptor — flagged by general-purpose bit 3.
        const local = new DataView(new ArrayBuffer(30))
        local.setUint32(0, 0x04034b50, true)
        local.setUint16(4, 20, true) // version needed
        local.setUint16(6, 0x0808, true) // bit 3 descriptor + bit 11 UTF-8
        local.setUint16(8, 0, true) // store (no compression)
        local.setUint16(10, time, true)
        local.setUint16(12, day, true)
        local.setUint16(26, nameBytes.length, true)
        local.setUint16(28, 0, true) // extra length
        controller.enqueue(new Uint8Array(local.buffer))
        controller.enqueue(nameBytes)
        offset += 30 + nameBytes.length

        let crc = 0
        let size = 0
        const reader = entry.input.stream().getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          // crc32 takes and returns finalized values, so the running value
          // feeds straight back in for the next chunk.
          crc = crc32(crc, value)
          size += value.length
          controller.enqueue(value)
        }
        offset += size

        const descriptor = new DataView(new ArrayBuffer(16))
        descriptor.setUint32(0, 0x08074b50, true)
        descriptor.setUint32(4, crc, true)
        descriptor.setUint32(8, size, true)
        descriptor.setUint32(12, size, true)
        controller.enqueue(new Uint8Array(descriptor.buffer))
        offset += 16

        central.push({ nameBytes, time, day, crc, size, headerOffset })
        return
      }

      // Central directory + end record, then done.
      const centralStart = offset
      for (const file of central) {
        const record = new DataView(new ArrayBuffer(46))
        record.setUint32(0, 0x02014b50, true)
        record.setUint16(4, 20, true) // version made by
        record.setUint16(6, 20, true) // version needed
        record.setUint16(8, 0x0808, true)
        record.setUint16(10, 0, true)
        record.setUint16(12, file.time, true)
        record.setUint16(14, file.day, true)
        record.setUint32(16, file.crc, true)
        record.setUint32(20, file.size, true)
        record.setUint32(24, file.size, true)
        record.setUint16(28, file.nameBytes.length, true)
        record.setUint32(42, file.headerOffset, true)
        controller.enqueue(new Uint8Array(record.buffer))
        controller.enqueue(file.nameBytes)
        offset += 46 + file.nameBytes.length
      }
      const end = new DataView(new ArrayBuffer(22))
      end.setUint32(0, 0x06054b50, true)
      end.setUint16(8, central.length, true)
      end.setUint16(10, central.length, true)
      end.setUint32(12, offset - centralStart, true)
      end.setUint32(16, centralStart, true)
      controller.enqueue(new Uint8Array(end.buffer))
      controller.close()
    },
  })
}
