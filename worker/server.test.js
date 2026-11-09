import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { applySchema, createEngine } from '../stack/engine.mjs'
import { createOwnStackHandler } from '../stack/handler.mjs'
import { blobKeyFrom } from '../stack/blobSign.mjs'
import { pendingStore, samlCacheProvider } from './pending.js'
import { createR2FileStore } from './files.js'
import { nodeRequest, nodeResponse } from './bridge.js'

async function database() {
  const db = new PGlite()
  await applySchema(db)
  return db
}

describe('sign-ins in progress kept in Postgres', () => {
  it('stores, reads once, deletes, and never returns an expired entry', async () => {
    const db = await database()
    const store = pendingStore(db)
    await store.set('state:abc', { verifier: 'v', at: 1 })
    expect(await store.get('state:abc')).toEqual({ verifier: 'v', at: 1 })
    expect(await store.delete('state:abc')).toBe(true)
    expect(await store.get('state:abc')).toBeUndefined()

    const short = pendingStore(db, { ttlSeconds: -1 })
    await short.set('state:old', { at: 1 })
    expect(await store.get('state:old')).toBeUndefined()
  })

  it('is invisible to the data API roles', async () => {
    const db = await database()
    await pendingStore(db).set('state:x', { verifier: 'secret' })
    for (const role of ['ohsms_browser', 'ohsms_worker']) {
      await expect(
        db.transaction(async (tx) => {
          await tx.exec(`SET LOCAL ROLE ${role}`)
          return tx.query('SELECT * FROM auth_pending')
        })
      ).rejects.toThrow()
    }
  })

  it('gives node-saml a cache that answers each request id once', async () => {
    const db = await database()
    const cache = samlCacheProvider(db)
    expect(await cache.saveAsync('_id1', '2026-01-01T00:00:00Z')).toMatchObject({ value: '2026-01-01T00:00:00Z' })
    expect(await cache.saveAsync('_id1', 'again')).toBeNull()
    expect(await cache.getAsync('_id1')).toBe('2026-01-01T00:00:00Z')
    expect(await cache.removeAsync('_id1')).toBe('_id1')
    expect(await cache.getAsync('_id1')).toBeNull()
    expect(await cache.removeAsync('_id1')).toBeNull()
  })
})

function fakeBucket() {
  const objects = new Map()
  return {
    objects,
    async put(key, body, { httpMetadata } = {}) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer())
      objects.set(key, { bytes, httpMetadata })
    },
    async get(key) {
      const o = objects.get(key)
      return o ? { body: o.bytes, size: o.bytes.length, httpMetadata: o.httpMetadata } : null
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}

describe('files in R2', () => {
  const origin = 'https://ehs.example.com'
  const key = blobKeyFrom('s'.repeat(40))

  it('uploads and downloads through signed links only', async () => {
    const bucket = fakeBucket()
    const files = createR2FileStore({ bucket, key, origin })
    const put = await files.handle(
      new Request(files.uploadUrl('files/photos/a.txt'), {
        method: 'PUT',
        body: 'hello',
        headers: { 'Content-Type': 'text/plain', 'Content-Length': '5' },
      })
    )
    expect(put.status).toBe(200)
    const got = await files.handle(new Request(files.downloadUrl('files/photos/a.txt')))
    expect(await got.text()).toBe('hello')
    expect(got.headers.get('content-security-policy')).toContain('sandbox')

    const forged = files.downloadUrl('files/photos/a.txt').replace(/sig=[^&]+/, 'sig=nope')
    expect((await files.handle(new Request(forged))).status).toBe(403)
    const outside = await files.handle(
      new Request(files.uploadUrl('secrets/x'), { method: 'PUT', body: 'x', headers: { 'Content-Length': '1' } })
    )
    expect(outside.status).toBe(403)
    expect(bucket.objects.has('secrets/x')).toBe(false)

    await files.remove('files/photos/a.txt')
    expect((await files.handle(new Request(files.downloadUrl('files/photos/a.txt')))).status).toBe(404)
  })

  it('refuses an upload link after it expires', async () => {
    const files = createR2FileStore({ bucket: fakeBucket(), key, origin })
    const link = files.uploadUrl('files/photos/b.txt')
    const late = await files.handle(
      new Request(link, { method: 'PUT', body: 'x', headers: { 'Content-Length': '1' } }),
      Date.now() + 16 * 60 * 1000
    )
    expect(late.status).toBe(403)
  })
})

describe('the server handler behind a Fetch request', () => {
  async function call(handle, request) {
    const { res, done, toResponse } = nodeResponse()
    await handle(nodeRequest(request), res)
    await done
    return toResponse()
  }

  it('answers /health, refuses a wrong setup code and runs /setup once', async () => {
    const db = await database()
    const saved = []
    const handle = createOwnStackHandler({
      engine: createEngine(db),
      db,
      sessionSecret: 's'.repeat(40),
      origin: 'https://ehs.example.com',
      auth: { method: 'none' },
      controlToken: 'c'.repeat(64),
      demoIssuer: false,
      codes: pendingStore(db),
      ensureSchema: async () => {},
      onAuthChange: (a) => saved.push(a),
    })
    const health = await call(handle, new Request('https://ehs.example.com/health'))
    expect(await health.json()).toEqual({ ok: true })

    const form = (code) =>
      new Request('https://ehs.example.com/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          orgName: 'Keel Works',
          contactName: 'Ana',
          contactEmail: 'ana@keel.test',
          method: 'oidc',
          authIssuer: 'https://login.keel.test',
          authClientId: 'ohsms',
          oidcClientSecret: 'secret',
        }).toString(),
      })
    expect((await call(handle, form('wrong'))).status).toBe(403)
    const ok = await call(handle, form('c'.repeat(64)))
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('Keel Works')
    expect(saved[0]).toMatchObject({ method: 'oidc', issuer: 'https://login.keel.test' })
    expect((await call(handle, form('c'.repeat(64)))).status).toBe(409)

    // Signed out, the data API sees nothing.
    const read = await call(
      handle,
      new Request('https://ehs.example.com/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'get', path: 'organization', id: 'profile' }),
      })
    )
    expect(await read.json()).toEqual({ doc: null })
  })
})

describe('a hosted Postgres that refuses BYPASSRLS', () => {
  it('still lets the server role reach every row and keeps the browser role confined', async () => {
    const db = new PGlite()
    // The shape a hosted database gives: the app is an ordinary role that may
    // create roles, and the worker role exists without the bypass right.
    await db.exec(`
      CREATE ROLE ohsms_browser NOLOGIN;
      CREATE ROLE ohsms_worker NOLOGIN;
      CREATE ROLE app NOLOGIN CREATEROLE;
      GRANT ohsms_browser, ohsms_worker TO app;
      ALTER SCHEMA public OWNER TO app;
      SET ROLE app;
    `)
    const who = await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')
    expect(who.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
    await applySchema(db)
    const engine = createEngine(db)
    const W = { role: 'ohsms_worker', uid: '' }
    await engine.commit(W, [
      { type: 'set', path: 'users', id: 'u1', merge: false, data: { role: 'member', status: 'approved' } },
      { type: 'set', path: 'incidents', id: 'i1', merge: false, data: { title: 'Cut' } },
      { type: 'set', path: 'scimTokens', id: 'current', merge: false, data: { hash: 'h' } },
    ])
    expect(await engine.get(W, 'scimTokens', 'current')).toMatchObject({ hash: 'h' })
    const member = { role: 'ohsms_browser', uid: 'u1' }
    expect(await engine.get(member, 'incidents', 'i1')).toMatchObject({ title: 'Cut' })
    expect(await engine.get(member, 'scimTokens', 'current')).toBeNull()
    expect(await engine.get({ role: 'ohsms_browser', uid: 'stranger' }, 'incidents', 'i1')).toBeNull()
  })
})
