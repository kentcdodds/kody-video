import { describe, expect, it } from 'vitest'
import { onRequest } from '../../functions/_middleware'
import {
  agentMarkdownResponse,
  pageIdForPath,
  prefersMarkdown,
  renderAgentMarkdown,
} from '../../functions/lib/agent-markdown'

function request(path: string, init?: RequestInit) {
  return new Request(`https://kody.video${path}`, init)
}

describe('pageIdForPath', () => {
  it('maps public pages and ignores project/api routes', () => {
    expect(pageIdForPath('/')).toBe('home')
    expect(pageIdForPath('/about')).toBe('about')
    expect(pageIdForPath('/privacy/')).toBe('privacy')
    expect(pageIdForPath('/terms')).toBe('terms')
    expect(pageIdForPath('/receive')).toBe('receive')
    expect(pageIdForPath('/auth.md')).toBe('auth')
    expect(pageIdForPath('/project/abc')).toBeNull()
    expect(pageIdForPath('/api/diag')).toBeNull()
    expect(pageIdForPath('/assets/app.js')).toBeNull()
  })
})

describe('prefersMarkdown', () => {
  it('requires an explicit text/markdown type and honors q-values', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true)
    expect(prefersMarkdown('text/markdown, text/html')).toBe(true)
    expect(prefersMarkdown('text/html;q=0.9, text/markdown')).toBe(true)
    expect(prefersMarkdown('text/html, text/markdown;q=0.1')).toBe(false)
    expect(prefersMarkdown('text/markdown;q=0')).toBe(false)
    expect(prefersMarkdown('text/html')).toBe(false)
    expect(prefersMarkdown('*/*')).toBe(false)
    expect(prefersMarkdown(null)).toBe(false)
  })
})

describe('renderAgentMarkdown', () => {
  it('emits frontmatter and the no-account rule', () => {
    const home = renderAgentMarkdown('home')
    expect(home.startsWith('---\n')).toBe(true)
    expect(home).toContain('title: Kody Video')
    expect(home).toContain('No accounts')

    const auth = renderAgentMarkdown('auth')
    expect(auth).toContain('no accounts')
    expect(auth).toContain('/api/verify-purchase')
    expect(auth).toContain('Do not invent a sign-in flow')
  })
})

describe('agentMarkdownResponse', () => {
  it('returns markdown for public pages when asked', async () => {
    const response = agentMarkdownResponse(
      request('/about', { headers: { accept: 'text/markdown' } }),
    )
    expect(response).not.toBeNull()
    expect(response?.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(response?.headers.get('content-signal')).toContain('search=yes')
    expect(response?.headers.get('vary')).toBe('Accept')
    const body = await response!.text()
    expect(body).toContain('# About Kody Video')
    expect(body).toContain('Private by design')
  })

  it('leaves HTML browsers on the SPA', () => {
    expect(agentMarkdownResponse(request('/about'))).toBeNull()
    expect(
      agentMarkdownResponse(request('/about', { headers: { accept: 'text/html' } })),
    ).toBeNull()
    expect(agentMarkdownResponse(request('/project/new'))).toBeNull()
    expect(
      agentMarkdownResponse(
        request('/api/diag', { headers: { accept: 'text/markdown' } }),
      ),
    ).toBeNull()
  })

  it('always serves /auth.md as markdown', async () => {
    const response = agentMarkdownResponse(request('/auth.md'))
    expect(response?.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(await response!.text()).toContain('# Authentication')
  })
})

describe('pages middleware', () => {
  it('passes unrelated requests through', async () => {
    const next = async () => new Response('spa', { status: 200 })
    const passed = await onRequest({
      request: request('/project/abc'),
      next,
    })
    expect(await passed.text()).toBe('spa')

    const markdown = await onRequest({
      request: request('/privacy', { headers: { accept: 'text/markdown' } }),
      next,
    })
    expect(markdown.headers.get('content-type')).toContain('text/markdown')
    expect(await markdown.text()).toContain('# Privacy')
  })
})
