import { describe, expect, it } from 'vitest'
import { handleSyncRequest, memorySyncKv } from './sync-rooms'

function env() {
  return { SYNC_ROOMS: memorySyncKv() }
}

async function body(response: Response) {
  return (await response.json()) as {
    code?: string
    status?: string
    offer?: string | null
    answer?: string | null
    error?: string
  }
}

describe('sync room HTTP', () => {
  it('returns 503 when the KV binding is missing', async () => {
    const response = await handleSyncRequest(
      new Request('https://kody.video/api/sync/rooms', { method: 'POST' }),
      {},
    )
    expect(response.status).toBe(503)
    expect((await body(response)).error).toMatch(/SYNC_ROOMS/)
  })

  it('creates a room and exchanges offer then answer', async () => {
    const rooms = env()
    const created = await handleSyncRequest(
      new Request('https://kody.video/api/sync/rooms', { method: 'POST' }),
      rooms,
    )
    expect(created.status).toBe(201)
    const room = await body(created)
    expect(room.code).toMatch(/^[A-Z2-9]{6}$/)
    expect(room.status).toBe('waiting')

    const offered = await handleSyncRequest(
      new Request(`https://kody.video/api/sync/rooms/${room.code}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offer: 'v=0 offer' }),
      }),
      rooms,
    )
    expect(offered.status).toBe(200)
    expect((await body(offered)).status).toBe('offered')

    const answered = await handleSyncRequest(
      new Request(`https://kody.video/api/sync/rooms/${room.code}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: 'v=0 answer' }),
      }),
      rooms,
    )
    expect((await body(answered)).status).toBe('answered')

    const got = await handleSyncRequest(
      new Request(`https://kody.video/api/sync/rooms/${room.code}`),
      rooms,
    )
    const view = await body(got)
    expect(view.offer).toBe('v=0 offer')
    expect(view.answer).toBe('v=0 answer')
  })

  it('rejects a second sender and an answer before an offer', async () => {
    const rooms = env()
    const created = await body(
      await handleSyncRequest(
        new Request('https://kody.video/api/sync/rooms', { method: 'POST' }),
        rooms,
      ),
    )
    const earlyAnswer = await handleSyncRequest(
      new Request(`https://kody.video/api/sync/rooms/${created.code}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: 'too-soon' }),
      }),
      rooms,
    )
    expect(earlyAnswer.status).toBe(409)

    await handleSyncRequest(
      new Request(`https://kody.video/api/sync/rooms/${created.code}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offer: 'first' }),
      }),
      rooms,
    )
    const second = await handleSyncRequest(
      new Request(`https://kody.video/api/sync/rooms/${created.code}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offer: 'second' }),
      }),
      rooms,
    )
    expect(second.status).toBe(409)
  })

  it('404s unknown or malformed codes', async () => {
    const rooms = env()
    const missing = await handleSyncRequest(
      new Request('https://kody.video/api/sync/rooms/ABCDEF'),
      rooms,
    )
    expect(missing.status).toBe(404)
    const bad = await handleSyncRequest(new Request('https://kody.video/api/sync/rooms/IIIIII'), rooms)
    expect(bad.status).toBe(400)
  })
})
