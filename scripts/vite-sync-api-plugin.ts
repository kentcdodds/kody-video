import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { handleSyncRequest, memorySyncKv } from '../src/lib/sync-rooms'

const kv = memorySyncKv()

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

/** In-memory /api/sync/* so Vite and Playwright can exercise send-to-device. */
export function syncApiPlugin(): Plugin {
  return {
    name: 'kody-sync-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/sync/')) {
          next()
          return
        }
        void nodeToRequest(req)
          .then((request) => handleSyncRequest(request, { SYNC_ROOMS: kv }))
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
