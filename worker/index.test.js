import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { SERVER_PREFIXES, forward, isServerPath } from './index.js'
import { API_PREFIXES } from '../stack/app.mjs'

const env = (over = {}) => ({
  ORIGIN_URL: 'https://ehs-origin.example.com',
  ASSETS: { fetch: vi.fn(async () => new Response('app')) },
  ...over,
})

afterEach(() => vi.unstubAllGlobals())

describe('which paths go to the organization server', () => {
  it('forwards every path the server answers', () => {
    for (const p of API_PREFIXES) expect(SERVER_PREFIXES, p).toContain(p)
    for (const path of [
      '/data',
      '/auth/password',
      '/presign',
      '/blob',
      '/rpc/getDataKeys',
      '/health',
      '/runtime-config.js',
    ]) {
      expect(isServerPath(path), path).toBe(true)
    }
  })

  it('leaves the app to the static assets', () => {
    for (const path of [
      '/',
      '/portal',
      '/incidents/123',
      '/assets/main.js',
      '/privacy',
      '/database',
      '/setup',
      '/scim/v2/Users',
    ]) {
      expect(isServerPath(path), path).toBe(false)
    }
  })
})

describe('forwarding', () => {
  it('sends the request to ORIGIN_URL with the service token, and passes a redirect through', async () => {
    const seen = []
    vi.stubGlobal('fetch', async (url, init) => {
      seen.push({ url: String(url), init })
      return new Response('', { status: 302, headers: { Location: 'https://idp.example/sso' } })
    })
    const req = new Request('https://ehs.example.com/auth/start?x=1', {
      headers: {
        'CF-Access-Client-Secret': 'forged',
        'CF-Connecting-IP': '203.0.113.9',
        // A visitor naming their own address for the server's limits.
        'X-OHSMS-Client-Ip': '10.0.0.1',
      },
    })
    const res = await forward(
      req,
      env({ CF_ACCESS_CLIENT_ID: 'id', CF_ACCESS_CLIENT_SECRET: 'secret' })
    )
    expect(seen[0].url).toBe('https://ehs-origin.example.com/auth/start?x=1')
    expect(seen[0].init.redirect).toBe('manual')
    expect(seen[0].init.headers.get('CF-Access-Client-Secret')).toBe('secret')
    expect(seen[0].init.headers.get('X-Forwarded-Host')).toBe('ehs.example.com')
    expect(seen[0].init.headers.get('X-Forwarded-For')).toBe('203.0.113.9')
    expect(seen[0].init.headers.get('X-OHSMS-Client-Ip')).toBe('203.0.113.9')
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('https://idp.example/sso')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('drops a browser-supplied Access credential when the Worker has none', async () => {
    let headers
    vi.stubGlobal('fetch', async (_url, init) => {
      headers = init.headers
      return new Response('{}')
    })
    await forward(
      new Request('https://ehs.example.com/data', {
        method: 'POST',
        body: '{}',
        headers: { 'CF-Access-Client-Id': 'x' },
      }),
      env()
    )
    expect(headers.has('CF-Access-Client-Id')).toBe(false)
  })

  it('refuses to forward without an https ORIGIN_URL', async () => {
    const res = await forward(
      new Request('https://ehs.example.com/data'),
      env({ ORIGIN_URL: 'http://10.0.0.5' })
    )
    expect(res.status).toBe(503)
  })

  it('answers 404, not index.html, for a script from a previous build', async () => {
    const html = new Response('<!doctype html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
    const e = env({ ASSETS: { fetch: vi.fn(async () => html) } })
    const res = await worker.fetch(new Request('https://ehs.example.com/assets/Gone-abc.js'), e)
    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('passes a script that exists straight through', async () => {
    const js = new Response('export {}', { headers: { 'Content-Type': 'text/javascript' } })
    const e = env({ ASSETS: { fetch: vi.fn(async () => js) } })
    const res = await worker.fetch(new Request('https://ehs.example.com/assets/index-x.js'), e)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('export {}')
  })

  it('serves the app for everything else', async () => {
    const e = env()
    const res = await worker.fetch(new Request('https://ehs.example.com/portal'), e)
    expect(await res.text()).toBe('app')
    expect(e.ASSETS.fetch).toHaveBeenCalled()
  })
})
