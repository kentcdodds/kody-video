/**
 * Serve markdown when an agent asks for it (Accept: text/markdown).
 * Cloudflare's zone-level Markdown for Agents converter is Pro+ only;
 * kody.video is on the Free plan, so this Function is the equivalent.
 */
import { agentMarkdownResponse } from './lib/agent-markdown'

interface PagesContext {
  request: Request
  next: () => Promise<Response>
}

export async function onRequest(context: PagesContext): Promise<Response> {
  return agentMarkdownResponse(context.request) ?? context.next()
}
