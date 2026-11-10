import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { SERVER_PREFIXES, isServerPath } from './index.js'
import { API_PREFIXES } from '../stack/app.mjs'

const env = (over = {}) => ({
  ASSETS: { fetch: vi.fn(async () => new Response('app')) },
  ...over,
})

afterEach(() => vi.unstubAllGlobals())

describe('which paths go to the organization server', () => {
  it('sends every path the server answers to the server', () => {
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

describe('the front door', () => {
  it('answers 503 for the server paths without a database, and still serves the app', async () => {
    const res = await worker.fetch(new Request('https://ehs.example.com/health'), env())
    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const app = await worker.fetch(new Request('https://ehs.example.com/portal'), env())
    expect(await app.text()).toBe('app')
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
