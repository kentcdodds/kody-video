import { describe, expect, it } from 'vitest'
import {
  decodeSyncHeader,
  encodeSyncHeader,
  formatRoomCode,
  normalizeRoomCode,
  randomRoomCode,
  ROOM_CODE_LENGTH,
  ROOM_CODE_PATTERN,
} from './sync-protocol'

describe('sync protocol', () => {
  it('mints unambiguous room codes', () => {
    const codes = new Set<string>()
    for (let i = 0; i < 40; i += 1) {
      const code = randomRoomCode()
      expect(code).toHaveLength(ROOM_CODE_LENGTH)
      expect(code).toMatch(ROOM_CODE_PATTERN)
      expect(code).not.toMatch(/[01IO]/)
      codes.add(code)
    }
    expect(codes.size).toBe(40)
  })

  it('normalizes typed codes and rejects lookalikes', () => {
    expect(normalizeRoomCode('ab3-k9q')).toBe('AB3K9Q')
    const minted = randomRoomCode()
    expect(normalizeRoomCode(` ${minted.slice(0, 3)}-${minted.slice(3)} `)).toBe(minted)
    expect(normalizeRoomCode('SHORT')).toBeNull()
    expect(normalizeRoomCode('IIIIII')).toBeNull()
  })

  it('formats a code for reading off a phone', () => {
    expect(formatRoomCode('AB3K9Q')).toBe('AB3-K9Q')
  })

  it('round-trips the DataChannel header', () => {
    const encoded = encodeSyncHeader({
      v: 1,
      byteLength: 1234,
      filename: 'trip.kodyvideo',
    })
    expect(decodeSyncHeader(encoded)).toEqual({
      v: 1,
      byteLength: 1234,
      filename: 'trip.kodyvideo',
    })
    expect(() => decodeSyncHeader('nope')).toThrow(/not a Kody Video project/)
  })
})
