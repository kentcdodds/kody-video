import { normalizeRoomCode, randomRoomCode, ROOM_CODE_PATTERN } from './sync-protocol'
import { SyncRoomError, type SyncKv, type SyncRoomsEnv } from './sync-rooms'

export const RESTORE_CODE_TTL_MS = 30 * 60 * 1000
const RESTORE_KEY_PREFIX = 'restore:'
const RATE_KEY_PREFIX = 'restore-rate:'
const CREATE_RATE_LIMIT = 30
const RATE_WINDOW_SEC = 10 * 60

export interface RestoreCodeRecord {
  code: string
  sessionId: string
  createdAt: number
  expiresAt: number
}

function restoreKey(code: string): string {
  return `${RESTORE_KEY_PREFIX}${code}`
}

async function readRestoreCode(kv: SyncKv, code: string): Promise<RestoreCodeRecord | null> {
  const raw = await kv.get(restoreKey(code), 'text')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as RestoreCodeRecord
    if (parsed.expiresAt <= Date.now()) {
      await kv.delete(restoreKey(code))
      return null
    }
    if (typeof parsed.sessionId !== 'string' || !ROOM_CODE_PATTERN.test(parsed.code)) {
      await kv.delete(restoreKey(code))
      return null
    }
    return parsed
  } catch {
    await kv.delete(restoreKey(code))
    return null
  }
}

async function writeRestoreCode(kv: SyncKv, record: RestoreCodeRecord): Promise<void> {
  const ttlSec = Math.max(30, Math.ceil((record.expiresAt - Date.now()) / 1000))
  await kv.put(restoreKey(record.code), JSON.stringify(record), { expirationTtl: ttlSec })
}

async function enforceCreateRateLimit(kv: SyncKv, ip: string): Promise<void> {
  const key = `${RATE_KEY_PREFIX}${ip}`
  const raw = await kv.get(key, 'text')
  let count = 0
  if (raw) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) count = parsed
  }
  if (count >= CREATE_RATE_LIMIT) {
    throw new SyncRoomError('Too many restore codes from this network. Try again in a few minutes.', 429)
  }
  await kv.put(key, String(count + 1), { expirationTtl: RATE_WINDOW_SEC })
}

export async function createRestoreCode(
  kv: SyncKv,
  sessionId: string,
  ip: string,
): Promise<string> {
  await enforceCreateRateLimit(kv, ip)
  const createdAt = Date.now()
  const expiresAt = createdAt + RESTORE_CODE_TTL_MS
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomRoomCode()
    if (await readRestoreCode(kv, code)) continue
    await writeRestoreCode(kv, { code, sessionId, createdAt, expiresAt })
    return code
  }
  throw new SyncRoomError('Could not allocate a restore code. Try again.', 503)
}

export async function getRestoreSessionId(kv: SyncKv, code: string): Promise<string> {
  const normalized = normalizeRoomCode(code)
  if (!normalized) throw new SyncRoomError('That is not a valid restore code.', 400)
  const record = await readRestoreCode(kv, normalized)
  if (!record) {
    throw new SyncRoomError('That code is not valid or has expired.', 404)
  }
  return record.sessionId
}

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? request.headers.get('x-forwarded-for') ?? 'local'
}

export function requireRestoreKv(env: SyncRoomsEnv): SyncKv {
  if (!env.SYNC_ROOMS) {
    throw new SyncRoomError(
      'Device restore codes are not configured on this deployment (missing SYNC_ROOMS).',
      503,
    )
  }
  return env.SYNC_ROOMS
}
