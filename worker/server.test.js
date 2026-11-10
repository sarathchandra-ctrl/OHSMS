import { openSqlite } from '../stack/sqlite.mjs'
import { describe, expect, it, vi } from 'vitest'
import { applySchema, createEngine } from '../stack/engine.mjs'
import { createOwnStackHandler } from '../stack/handler.mjs'
import { blobKeyFrom } from '../stack/blobSign.mjs'
import { bootstrapOrganization } from '../stack/passwords.mjs'
import { createR2FileStore } from './files.js'
import { nodeRequest, nodeResponse } from './bridge.js'
import { serveOnCloudflare } from './server.js'
import { MAX_UPLOAD_BYTES, MAX_SEALED_UPLOAD_BYTES } from '../stack/lib/uploadLimits.js'

async function database() {
  const db = openSqlite()
  await applySchema(db)
  return db
}

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
    async head(key) {
      const o = objects.get(key)
      return o ? { size: o.bytes.length, httpMetadata: o.httpMetadata } : null
    },
  }
}

describe('files in R2', () => {
  const origin = 'https://ehs.example.com'
  const key = blobKeyFrom('s'.repeat(40))

  // A fresh upload link for a path that already holds a file is the way to
  // swap someone's evidence for something else. Every real upload gets a new
  // random path, so the second PUT is never legitimate.
  it('never replaces a stored file', async () => {
    const bucket = fakeBucket()
    const files = createR2FileStore({ bucket, key, origin })
    const put = (body) =>
      files.handle(
        new Request(files.uploadUrl('files/photos/evidence.txt'), {
          method: 'PUT',
          body,
          headers: { 'Content-Type': 'text/plain', 'Content-Length': String(body.length) },
        })
      )
    expect((await put('original')).status).toBe(200)
    expect((await put('swapped')).status).toBe(409)
    const got = await files.handle(new Request(files.downloadUrl('files/photos/evidence.txt')))
    expect(await got.text()).toBe('original')
  })

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
      new Request(files.uploadUrl('secrets/x'), {
        method: 'PUT',
        body: 'x',
        headers: { 'Content-Length': '1' },
      })
    )
    expect(outside.status).toBe(403)
    expect(bucket.objects.has('secrets/x')).toBe(false)

    await files.remove('files/photos/a.txt')
    expect((await files.handle(new Request(files.downloadUrl('files/photos/a.txt')))).status).toBe(
      404
    )
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

  it('accepts exactly 2 MB and refuses an extra byte without storing it', async () => {
    const bucket = fakeBucket()
    const files = createR2FileStore({ bucket, key, origin })
    // Each upload has its own path, as every real one does.
    const upload = (path, size) =>
      files.handle(
        new Request(files.uploadUrl(path), {
          method: 'PUT',
          body: new Uint8Array(size),
          headers: { 'Content-Type': 'application/pdf' },
        })
      )
    expect((await upload('files/photos/limit.pdf', MAX_UPLOAD_BYTES)).status).toBe(200)
    expect((await upload('files/photos/over.pdf', MAX_UPLOAD_BYTES + 1)).status).toBe(413)
    expect(bucket.objects.get('files/photos/limit.pdf').bytes.length).toBe(MAX_UPLOAD_BYTES)
    expect(bucket.objects.has('files/photos/over.pdf')).toBe(false)
  })

  it('counts a streamed body even if the declared length is smaller', async () => {
    const bucket = fakeBucket()
    const files = createR2FileStore({ bucket, key, origin })
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_UPLOAD_BYTES))
        controller.enqueue(new Uint8Array(1))
        controller.close()
      },
    })
    const res = await files.handle(
      new Request(files.uploadUrl('files/photos/stream.pdf'), {
        method: 'PUT',
        body: stream,
        duplex: 'half',
        headers: { 'Content-Type': 'application/pdf', 'Content-Length': '1' },
      })
    )
    expect(res.status).toBe(413)
    expect(bucket.objects.size).toBe(0)
  })

  it('rejects invalid or mismatched lengths before storing the file', async () => {
    const bucket = fakeBucket()
    const files = createR2FileStore({ bucket, key, origin })
    for (const length of ['-1', 'NaN', '2']) {
      const res = await files.handle(
        new Request(files.uploadUrl('files/photos/bad.txt'), {
          method: 'PUT',
          body: 'x',
          headers: { 'Content-Length': length },
        })
      )
      expect(res.status).toBe(400)
    }
    expect(bucket.objects.size).toBe(0)
  })

  it('allows only the authentication-tag overhead for a sealed 2 MB file', async () => {
    const bucket = fakeBucket()
    const files = createR2FileStore({ bucket, key, origin })
    const upload = (path, size) =>
      files.handle(
        new Request(files.uploadUrl(path), {
          method: 'PUT',
          body: new Uint8Array(size),
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      )
    expect((await upload('files/medical/a.bin', MAX_SEALED_UPLOAD_BYTES)).status).toBe(200)
    expect((await upload('files/medical/b.bin', MAX_SEALED_UPLOAD_BYTES + 1)).status).toBe(413)
  })
})

describe('Cloudflare startup', () => {
  const settings = (DB) => ({
    DB,
    PUBLIC_ORIGIN: 'https://ehs.example.com',
    SESSION_SECRET: 's'.repeat(40),
    DATA_KEY_MASTER: Buffer.alloc(32).toString('base64'),
    ADMIN_EMAIL: 'admin@example.test',
    ADMIN_PASSWORD: 'first-admin-pass-1',
  })

  it('serves the blocking runtime settings script without any database calls', async () => {
    const prepare = vi.fn(() => {
      throw new Error('D1 unavailable')
    })
    const res = await serveOnCloudflare(
      new Request('https://ehs.example.com/runtime-config.js'),
      settings({ prepare })
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('https://ehs.example.com')
    expect(prepare).not.toHaveBeenCalled()
  })

  it('shares concurrent initialization and initializes each database separately', async () => {
    for (let i = 0; i < 2; i++) {
      const db = openSqlite()
      try {
        const env = { ...settings(db), BUILD_COMMIT: 'test-build' }
        const health = () => serveOnCloudflare(new Request('https://ehs.example.com/health'), env)
        const responses = await Promise.all([health(), health(), health()])
        for (const res of responses) {
          expect(res.status).toBe(200)
          expect(await res.json()).toMatchObject({ ok: true, database: 'ok', version: 'test-build' })
        }
        const { count } = await db.prepare('SELECT count(*) AS count FROM auth_secrets').first()
        expect(count).toBe(1)
      } finally {
        db.close()
      }
    }
  })
})

describe('the server handler behind a Fetch request', () => {
  async function call(handle, request) {
    const { res, done, toResponse } = nodeResponse()
    await handle(nodeRequest(request), res)
    await done
    return toResponse()
  }

  it('answers /health and signs in with a password', async () => {
    const db = await database()
    const engine = createEngine(db)
    await bootstrapOrganization(engine, db, {
      orgName: 'Cult Fit',
      adminEmail: 'ana@cult.test',
      adminPassword: 'first-admin-pass-1',
    })
    const handle = createOwnStackHandler({ engine, db, sessionSecret: 's'.repeat(40) })
    const health = await call(handle, new Request('https://ehs.example.com/health'))
    expect(await health.json()).toEqual({ ok: true })
    const signIn = (password) =>
      call(
        handle,
        new Request('https://ehs.example.com/auth/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'ana@cult.test', password }),
        })
      )
    expect((await signIn('wrong-password-0')).status).toBe(401)
    const ok = await signIn('first-admin-pass-1')
    expect(ok.status).toBe(200)
    expect((await ok.json()).token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)

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
