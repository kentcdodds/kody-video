import { handleSyncRequest, type SyncKv } from '../../../src/lib/sync-rooms'

interface Env {
  SYNC_ROOMS?: SyncKv
}

interface PagesContext {
  request: Request
  env: Env
}

/** Matchmaker only — room codes and WebRTC descriptions, never media. */
export async function onRequest(context: PagesContext): Promise<Response> {
  return handleSyncRequest(context.request, context.env)
}
