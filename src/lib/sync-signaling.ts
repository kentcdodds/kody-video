import { normalizeRoomCode, type SyncRoomView } from './sync-protocol'

export class SyncSignalError extends Error {
  override readonly name = 'SyncSignalError'
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

async function readRoomResponse(response: Response): Promise<SyncRoomView> {
  const body = (await response.json().catch(() => null)) as
    | (Partial<SyncRoomView> & { error?: string })
    | null
  if (!response.ok) {
    throw new SyncSignalError(body?.error ?? 'Could not reach the send room.', response.status)
  }
  if (!body || typeof body.code !== 'string') {
    throw new SyncSignalError('The send room returned a damaged response.')
  }
  return {
    code: body.code,
    status: body.status === 'answered' || body.status === 'offered' ? body.status : 'waiting',
    offer: typeof body.offer === 'string' ? body.offer : null,
    answer: typeof body.answer === 'string' ? body.answer : null,
    createdAt: typeof body.createdAt === 'number' ? body.createdAt : Date.now(),
  }
}

export async function createSyncRoom(): Promise<SyncRoomView> {
  const response = await fetch('/api/sync/rooms', {
    method: 'POST',
    headers: { accept: 'application/json' },
  })
  return readRoomResponse(response)
}

export async function fetchSyncRoom(code: string): Promise<SyncRoomView> {
  const normalized = normalizeRoomCode(code)
  if (!normalized) throw new SyncSignalError('That is not a valid send code.')
  const response = await fetch(`/api/sync/rooms/${encodeURIComponent(normalized)}`, {
    headers: { accept: 'application/json' },
  })
  return readRoomResponse(response)
}

export async function publishSyncOffer(code: string, offer: string): Promise<SyncRoomView> {
  const normalized = normalizeRoomCode(code)
  if (!normalized) throw new SyncSignalError('That is not a valid send code.')
  const response = await fetch(`/api/sync/rooms/${encodeURIComponent(normalized)}`, {
    method: 'PUT',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ offer }),
  })
  return readRoomResponse(response)
}

export async function publishSyncAnswer(code: string, answer: string): Promise<SyncRoomView> {
  const normalized = normalizeRoomCode(code)
  if (!normalized) throw new SyncSignalError('That is not a valid send code.')
  const response = await fetch(`/api/sync/rooms/${encodeURIComponent(normalized)}`, {
    method: 'PUT',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ answer }),
  })
  return readRoomResponse(response)
}

export async function waitForSyncRoom(
  code: string,
  ready: (room: SyncRoomView) => boolean,
  signal: AbortSignal,
  intervalMs = 700,
): Promise<SyncRoomView> {
  while (!signal.aborted) {
    const room = await fetchSyncRoom(code)
    if (ready(room)) return room
    await sleep(intervalMs, signal)
  }
  throw new DOMException('Send cancelled.', 'AbortError')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Send cancelled.', 'AbortError'))
      return
    }
    const timer = window.setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer)
        reject(new DOMException('Send cancelled.', 'AbortError'))
      },
      { once: true },
    )
  })
}

export interface SyncSignaling {
  publishOffer(sdp: string): Promise<void>
  publishAnswer(sdp: string): Promise<void>
  waitForOffer(signal: AbortSignal): Promise<string>
  waitForAnswer(signal: AbortSignal): Promise<string>
}

export function httpSyncSignaling(code: string): SyncSignaling {
  return {
    async publishOffer(sdp) {
      await publishSyncOffer(code, sdp)
    },
    async publishAnswer(sdp) {
      await publishSyncAnswer(code, sdp)
    },
    async waitForOffer(signal) {
      const room = await waitForSyncRoom(code, (current) => Boolean(current.offer), signal)
      if (!room.offer) throw new SyncSignalError('The sender never published a connection.')
      return room.offer
    },
    async waitForAnswer(signal) {
      const room = await waitForSyncRoom(code, (current) => Boolean(current.answer), signal)
      if (!room.answer) throw new SyncSignalError('The receiver never published a connection.')
      return room.answer
    },
  }
}
