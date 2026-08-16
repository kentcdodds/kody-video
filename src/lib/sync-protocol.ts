/** Shared wire types for Plus “Send to device” (signaling + DataChannel). */

export const ROOM_CODE_LENGTH = 6
/** Crockford-ish: no 0/O/1/I so a code read off a phone is unambiguous. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/
export const ROOM_TTL_MS = 10 * 60 * 1000
export const SYNC_CHUNK_BYTES = 16 * 1024
export const SYNC_HEADER_PREFIX = 'KODY1'
export const SYNC_EOF = 'KODY1EOF'

export const STUN_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]

export type SyncRoomStatus = 'waiting' | 'offered' | 'answered'

export interface SyncRoomView {
  code: string
  status: SyncRoomStatus
  offer: string | null
  answer: string | null
  createdAt: number
}

export interface SyncRoomRecord extends SyncRoomView {
  expiresAt: number
}

export interface SyncBackupHeader {
  v: 1
  byteLength: number
  filename: string
}

export type SyncPhase =
  | 'creating'
  | 'waiting'
  | 'connecting'
  | 'transferring'
  | 'importing'
  | 'done'
  | 'failed'

export function randomRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH)
  crypto.getRandomValues(bytes)
  let code = ''
  for (const byte of bytes) {
    code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]
  }
  return code
}

/** Strip spaces/hyphens and uppercase; null when it is not a valid code. */
export function normalizeRoomCode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return ROOM_CODE_PATTERN.test(compact) ? compact : null
}

export function formatRoomCode(code: string): string {
  const normalized = normalizeRoomCode(code) ?? code.toUpperCase()
  if (normalized.length !== ROOM_CODE_LENGTH) return normalized
  return `${normalized.slice(0, 3)}-${normalized.slice(3)}`
}

export function isSyncBackupHeader(value: unknown): value is SyncBackupHeader {
  if (value === null || typeof value !== 'object') return false
  const header = value as Partial<SyncBackupHeader>
  return (
    header.v === 1 &&
    typeof header.byteLength === 'number' &&
    Number.isFinite(header.byteLength) &&
    header.byteLength > 0 &&
    typeof header.filename === 'string' &&
    header.filename.length > 0
  )
}

export function encodeSyncHeader(header: SyncBackupHeader): string {
  return `${SYNC_HEADER_PREFIX}${JSON.stringify(header)}`
}

export function decodeSyncHeader(message: string): SyncBackupHeader {
  if (!message.startsWith(SYNC_HEADER_PREFIX)) {
    throw new Error('This device sent something that is not a Kody Video project.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(message.slice(SYNC_HEADER_PREFIX.length))
  } catch {
    throw new Error('This device sent a damaged project header.')
  }
  if (!isSyncBackupHeader(parsed)) {
    throw new Error('This device sent a damaged project header.')
  }
  return parsed
}
