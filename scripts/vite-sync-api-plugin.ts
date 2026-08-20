import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { createRestoreCode, getRestoreSessionId } from '../src/lib/restore-codes'
import { jsonResponse, handleSyncRequest, memorySyncKv, SyncRoomError } from '../src/lib/sync-rooms'

const kv = memorySyncKv()
const LOCAL_TEST_SESSION = /^cs_test_[a-zA-Z0-9]+$/

async function nodeToRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? '127.0.0.1'
  const url = `http://${host}${req.url ?? '/'}`
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const body = Buffer.concat(chunks)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) headers.set(name, value.join(', '))
  }
  const method = req.method ?? 'GET'
  return new Request(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  })
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, name) => {
    res.setHeader(name, value)
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  res.end(bytes)
}

/** Local-only: accept cs_test_* sessions so Playwright can pair devices without Stripe. */
async function handleLocalPurchase(request: Request): Promise<Response> {
  const url = new URL(request.url)
  try {
    if (url.pathname === '/api/restore-codes') {
      if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405)
      const posted = (await request.json().catch(() => null)) as { session_id?: unknown } | null
      const sessionId = typeof posted?.session_id === 'string' ? posted.session_id : ''
      if (!LOCAL_TEST_SESSION.test(sessionId)) {
        return jsonResponse({ error: 'Local restore codes only accept cs_test_ sessions.' }, 400)
      }
      const code = await createRestoreCode(kv, sessionId, 'local')
      return jsonResponse({ code }, 201)
    }

    if (url.pathname === '/api/verify-purchase') {
      if (request.method !== 'GET') return jsonResponse({ unlocked: false, error: 'Method not allowed.' }, 405)
      let sessionId = url.searchParams.get('session_id') ?? ''
      const code = url.searchParams.get('code') ?? ''
      if (code) sessionId = await getRestoreSessionId(kv, code)
      if (!LOCAL_TEST_SESSION.test(sessionId)) {
        return jsonResponse({ unlocked: false, error: 'No such purchase.' }, 404)
      }
      return jsonResponse({ unlocked: true, sessionId }, 200)
    }
  } catch (error) {
    if (error instanceof SyncRoomError) {
      const payload =
        url.pathname === '/api/verify-purchase'
          ? { unlocked: false, error: error.message }
          : { error: error.message }
      return jsonResponse(payload, error.status)
    }
    throw error
  }
  return jsonResponse({ error: 'Not found.' }, 404)
}

/** In-memory /api/sync/* and Plus restore-code endpoints for Vite and Playwright. */
export function syncApiPlugin(): Plugin {
  return {
    name: 'kody-sync-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? ''
        const purchase =
          path === '/api/restore-codes' || path === '/api/verify-purchase'
        if (!path.startsWith('/api/sync/') && !purchase) {
          next()
          return
        }
        void nodeToRequest(req)
          .then((request) =>
            purchase
              ? handleLocalPurchase(request)
              : handleSyncRequest(request, { SYNC_ROOMS: kv }),
          )
          .then((response) => writeResponse(res, response))
          .catch((error: unknown) => {
            res.statusCode = 500
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'sync api' }))
          })
      })
    },
  }
}
