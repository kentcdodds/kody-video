import {
  normalizeRoomCode,
  randomRoomCode,
  ROOM_TTL_MS,
  type SyncRoomRecord,
  type SyncRoomStatus,
  type SyncRoomView,
} from './sync-protocol'

export interface SyncKv {
  get(key: string, type: 'text'): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export interface SyncRoomsEnv {
  SYNC_ROOMS?: SyncKv
}

const ROOM_KEY_PREFIX = 'room:'
const RATE_KEY_PREFIX = 'rate:'
const CREATE_RATE_LIMIT = 30
const RATE_WINDOW_SEC = 10 * 60

export class SyncRoomError extends Error {
  override readonly name = 'SyncRoomError'
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}

export function memorySyncKv(): SyncKv {
  const values = new Map<string, { value: string; expiresAt: number }>()
  const now = () => Date.now()
  const read = (key: string): string | null => {
    const entry = values.get(key)
    if (!entry) return null
    if (entry.expiresAt <= now()) {
      values.delete(key)
      return null
    }
    return entry.value
  }
  return {
    async get(key) {
      return read(key)
    },
    async put(key, value, options) {
      const ttlMs = (options?.expirationTtl ?? 600) * 1000
      values.set(key, { value, expiresAt: now() + ttlMs })
    },
    async delete(key) {
      values.delete(key)
    },
  }
}

function roomKey(code: string): string {
  return `${ROOM_KEY_PREFIX}${code}`
}

function viewOf(record: SyncRoomRecord): SyncRoomView {
  return {
    code: record.code,
    status: record.status,
    offer: record.offer,
    answer: record.answer,
    createdAt: record.createdAt,
  }
}

function statusOf(record: Pick<SyncRoomRecord, 'offer' | 'answer'>): SyncRoomStatus {
  if (record.answer) return 'answered'
  if (record.offer) return 'offered'
  return 'waiting'
}

async function readRoom(kv: SyncKv, code: string): Promise<SyncRoomRecord | null> {
  const raw = await kv.get(roomKey(code), 'text')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as SyncRoomRecord
    if (parsed.expiresAt <= Date.now()) {
      await kv.delete(roomKey(code))
      return null
    }
    return parsed
  } catch {
    await kv.delete(roomKey(code))
    return null
  }
}

async function writeRoom(kv: SyncKv, record: SyncRoomRecord): Promise<void> {
  const ttlSec = Math.max(30, Math.ceil((record.expiresAt - Date.now()) / 1000))
  await kv.put(roomKey(record.code), JSON.stringify(record), { expirationTtl: ttlSec })
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
    throw new SyncRoomError('Too many send rooms from this network. Try again in a few minutes.', 429)
  }
  await kv.put(key, String(count + 1), { expirationTtl: RATE_WINDOW_SEC })
}

export async function createSyncRoom(kv: SyncKv, ip: string): Promise<SyncRoomView> {
  await enforceCreateRateLimit(kv, ip)
  const createdAt = Date.now()
  const expiresAt = createdAt + ROOM_TTL_MS
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomRoomCode()
    if (await readRoom(kv, code)) continue
    const record: SyncRoomRecord = {
      code,
      status: 'waiting',
      offer: null,
      answer: null,
      createdAt,
      expiresAt,
    }
    await writeRoom(kv, record)
    return viewOf(record)
  }
  throw new SyncRoomError('Could not allocate a send code. Try again.', 503)
}

export async function getSyncRoom(kv: SyncKv, code: string): Promise<SyncRoomView> {
  const normalized = normalizeRoomCode(code)
  if (!normalized) throw new SyncRoomError('That is not a valid send code.', 400)
  const record = await readRoom(kv, normalized)
  if (!record) throw new SyncRoomError('No send waiting with that code — it may have expired.', 404)
  return viewOf(record)
}

export async function updateSyncRoom(
  kv: SyncKv,
  code: string,
  patch: { offer?: string; answer?: string },
): Promise<SyncRoomView> {
  const normalized = normalizeRoomCode(code)
  if (!normalized) throw new SyncRoomError('That is not a valid send code.', 400)
  const record = await readRoom(kv, normalized)
  if (!record) throw new SyncRoomError('No send waiting with that code — it may have expired.', 404)

  const offer = typeof patch.offer === 'string' ? patch.offer.trim() : ''
  const answer = typeof patch.answer === 'string' ? patch.answer.trim() : ''
  if (offer && answer) {
    throw new SyncRoomError('Send one description at a time.', 400)
  }
  if (!offer && !answer) {
    throw new SyncRoomError('Missing connection description.', 400)
  }
  if (offer.length > 20_000 || answer.length > 20_000) {
    throw new SyncRoomError('Connection description is too large.', 413)
  }

  if (offer) {
    if (record.offer) throw new SyncRoomError('This send already has a sender.', 409)
    record.offer = offer
  } else {
    if (!record.offer) throw new SyncRoomError('The sender has not published a connection yet.', 409)
    if (record.answer) throw new SyncRoomError('This send already has a receiver.', 409)
    record.answer = answer
  }
  record.status = statusOf(record)
  await writeRoom(kv, record)
  return viewOf(record)
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? request.headers.get('x-forwarded-for') ?? 'local'
}

function requireKv(env: SyncRoomsEnv): SyncKv {
  if (!env.SYNC_ROOMS) {
    throw new SyncRoomError(
      'Send-to-device is not configured on this deployment (missing SYNC_ROOMS).',
      503,
    )
  }
  return env.SYNC_ROOMS
}

/**
 * HTTP surface used by the Pages Function and the Vite dev middleware:
 * POST /api/sync/rooms
 * GET  /api/sync/rooms/:code
 * PUT  /api/sync/rooms/:code  { offer? | answer? }
 */
export async function handleSyncRequest(request: Request, env: SyncRoomsEnv): Promise<Response> {
  try {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'api' || parts[1] !== 'sync' || parts[2] !== 'rooms') {
      return jsonResponse({ error: 'Not found.' }, 404)
    }
    const code = parts[3]
    if (parts.length > 4) return jsonResponse({ error: 'Not found.' }, 404)

    if (!code) {
      if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405)
      const room = await createSyncRoom(requireKv(env), clientIp(request))
      return jsonResponse(room, 201)
    }

    switch (request.method) {
      case 'GET':
        return jsonResponse(await getSyncRoom(requireKv(env), code))
      case 'PUT': {
        const body = (await request.json().catch(() => null)) as {
          offer?: unknown
          answer?: unknown
        } | null
        const room = await updateSyncRoom(requireKv(env), code, {
          offer: typeof body?.offer === 'string' ? body.offer : undefined,
          answer: typeof body?.answer === 'string' ? body.answer : undefined,
        })
        return jsonResponse(room)
      }
      default:
        return jsonResponse({ error: 'Method not allowed.' }, 405)
    }
  } catch (error) {
    if (error instanceof SyncRoomError) {
      return jsonResponse({ error: error.message }, error.status)
    }
    return jsonResponse({ error: 'Could not update the send room.' }, 500)
  }
}
