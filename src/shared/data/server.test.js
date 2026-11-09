// The organization's server as deployed (stack/app.mjs), on an in-memory
// SQLite — the same engine as Cloudflare D1. These sign in with email and
// password through HTTP and try the doors that must stay shut.
import { openSqlite } from '../../../stack/sqlite.mjs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createDedicatedApp, runtimeConfigScript } from '../../../stack/app.mjs'
import { MAX_FAILURES } from '../../../stack/passwords.mjs'

const ADMIN = { email: 'ana@cult.test', password: 'first-admin-pass-1' }
const SECRET = 's'.repeat(40)

async function hostedLikeDb() {
  return openSqlite()
}

function staticDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ohsms-app-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>')
  writeFileSync(join(dir, 'assets', 'main-abc.js'), 'console.log(1)')
  return dir
}

async function start({ db, dir = '', bootstrap } = {}) {
  const database = db || (await hostedLikeDb())
  const app = await createDedicatedApp({
    db: database,
    origin: 'https://ehs.example.com',
    sessionSecret: SECRET,
    dataKeyMaster: Buffer.alloc(32, 7).toString('base64'),
    staticDir: dir,
    bootstrap: bootstrap ?? { orgName: 'Cult Fit', adminEmail: ADMIN.email, adminPassword: ADMIN.password },
  })
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${app.server.address().port}`
  const post = (path, body, token) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
  const signIn = async (email, password) => (await post('/auth/password', { email, password })).body.token
  const read = async (token, path, id) => (await post('/data', { op: 'get', path, id }, token)).body.doc
  const rpc = (token, name, body = {}) => post(`/rpc/${name}`, body, token)
  const stop = () => new Promise((resolve) => app.server.close(resolve))
  return { ...app, db: database, origin, post, signIn, read, rpc, stop }
}

/** Signed in as the bootstrapped admin, with the temporary password replaced. */
async function readyAdmin(s) {
  const temp = await s.signIn(ADMIN.email, ADMIN.password)
  const changed = await s.rpc(temp, 'completePasswordChange', {
    current: ADMIN.password,
    password: 'admin-own-pass-2',
  })
  expect(changed.body).toEqual({ ok: true })
  return s.signIn(ADMIN.email, 'admin-own-pass-2')
}

describe('first start', () => {
  it('creates the organization and its administrator once, and never again', async () => {
    const db = await hostedLikeDb()
    const first = await start({ db })
    expect(first.created).toMatchObject({ created: true })
    await first.stop()
    const again = await start({ db, bootstrap: { orgName: 'Other', adminEmail: 'eve@evil.test', adminPassword: 'eve-password-1' } })
    expect(again.created).toEqual({ created: false })
    expect(await again.signIn('eve@evil.test', 'eve-password-1')).toBeUndefined()
    const admin = await readyAdmin(again)
    expect(await again.read(admin, 'organization', 'profile')).toMatchObject({ name: 'Cult Fit' })
    await again.stop()
  })
})

describe('signing in', () => {
  it('admits the right password and nothing else, without saying which part was wrong', async () => {
    const s = await start()
    const wrong = await s.post('/auth/password', { email: ADMIN.email, password: 'nope-nope-nope' })
    const nobody = await s.post('/auth/password', { email: 'ghost@cult.test', password: 'nope-nope-nope' })
    expect(wrong.status).toBe(401)
    expect(nobody.status).toBe(401)
    expect(wrong.body.message).toBe(nobody.body.message)
    expect(await s.signIn(ADMIN.email.toUpperCase(), ADMIN.password)).toBeTruthy()
    await s.stop()
  })

  it('locks an address after repeated wrong passwords, even for the right one', async () => {
    const s = await start()
    for (let i = 0; i < MAX_FAILURES; i++) {
      await s.post('/auth/password', { email: ADMIN.email, password: `wrong-guess-${i}` })
    }
    const locked = await s.post('/auth/password', ADMIN)
    expect(locked.status).toBe(429)
    expect(locked.body.token).toBeUndefined()
    await s.stop()
  })

  it('holds a temporary password at the gate until it is replaced', async () => {
    const s = await start()
    const temp = await s.signIn(ADMIN.email, ADMIN.password)
    // The person can see their own profile (to be shown the change screen)…
    expect(await s.read(temp, 'users', JSON.parse(Buffer.from(temp.split('.')[1], 'base64url')).sub))
      .toMatchObject({ mustChangePassword: true })
    // …and nothing else.
    expect(await s.read(temp, 'organization', 'profile')).toBeNull()
    const weak = await s.rpc(temp, 'completePasswordChange', { current: ADMIN.password, password: 'short' })
    expect(weak.body).toMatchObject({ ok: false, reason: 'policy' })
    const wrong = await s.rpc(temp, 'completePasswordChange', { current: 'not-it-at-all', password: 'another-pass-3' })
    expect(wrong.body).toMatchObject({ ok: false, reason: 'current-rejected' })
    const admin = await readyAdmin(s)
    expect(await s.read(admin, 'organization', 'profile')).toMatchObject({ name: 'Cult Fit' })
    expect(await s.signIn(ADMIN.email, ADMIN.password)).toBeUndefined()
    await s.stop()
  })

  it('refuses a forged session', async () => {
    const s = await start()
    const admin = await readyAdmin(s)
    const forged = admin.split('.').slice(0, 2).join('.') + '.not-a-signature'
    expect(await s.read(forged, 'organization', 'profile')).toBeNull()
    expect((await s.rpc(forged, 'createMember', { email: 'x@cult.test', role: 'admin', password: 'xxxxxxxxxxxx' })).status).toBe(401)
    await s.stop()
  })
})

describe('adding people', () => {
  it('lets an admin add an employee who signs in and must choose a password', async () => {
    const s = await start()
    const admin = await readyAdmin(s)
    const made = await s.rpc(admin, 'createMember', {
      email: 'Mo@Cult.test',
      name: 'Mo',
      role: 'member',
      password: 'temporary-pass-9',
    })
    expect(made.body).toMatchObject({ ok: true, email: 'mo@cult.test', role: 'member' })
    const dup = await s.rpc(admin, 'createMember', { email: 'mo@cult.test', role: 'member', password: 'temporary-pass-9' })
    expect(dup.body).toMatchObject({ ok: false, reason: 'already-member' })

    const mo = await s.signIn('mo@cult.test', 'temporary-pass-9')
    expect(await s.read(mo, 'organization', 'profile')).toBeNull()
    await s.rpc(mo, 'completePasswordChange', { current: 'temporary-pass-9', password: 'mo-own-pass-10' })
    const moReady = await s.signIn('mo@cult.test', 'mo-own-pass-10')
    expect(await s.read(moReady, 'organization', 'profile')).toMatchObject({ name: 'Cult Fit' })

    // A member cannot add people or reset passwords.
    expect((await s.rpc(moReady, 'createMember', { email: 'z@cult.test', role: 'admin', password: 'zzzzzzzzzzzz' })).body)
      .toMatchObject({ ok: false, reason: 'not-admin' })
    expect((await s.rpc(moReady, 'resetMemberPassword', { uid: made.body.uid, password: 'zzzzzzzzzzzz' })).body)
      .toMatchObject({ ok: false, reason: 'not-admin' })
    await s.stop()
  })

  it('lets an admin reset a forgotten password, which must then be changed', async () => {
    const s = await start()
    const admin = await readyAdmin(s)
    const made = await s.rpc(admin, 'createMember', { email: 'lu@cult.test', role: 'manager', password: 'temporary-pass-9' })
    const reset = await s.rpc(admin, 'resetMemberPassword', { uid: made.body.uid, password: 'reset-pass-11x' })
    expect(reset.body).toEqual({ ok: true })
    expect(await s.signIn('lu@cult.test', 'temporary-pass-9')).toBeUndefined()
    const lu = await s.signIn('lu@cult.test', 'reset-pass-11x')
    expect(await s.read(lu, 'organization', 'profile')).toBeNull()
    await s.stop()
  })

  it('keeps passwords out of the data API, admin included', async () => {
    const s = await start()
    const admin = await readyAdmin(s)
    const res = await s.post('/data', { op: 'list', path: 'auth_secrets', opts: {} }, admin)
    expect(JSON.stringify(res.body)).not.toContain('pbkdf2')
    const users = await s.post('/data', { op: 'list', path: 'users', opts: {} }, admin)
    expect(JSON.stringify(users.body)).not.toContain('pbkdf2')
    await s.stop()
  })
})

describe('serving the built app', () => {
  it('serves files, falls back to the app for client routes, and keeps the API', async () => {
    const s = await start({ dir: staticDir() })
    const asset = await fetch(`${s.origin}/assets/main-abc.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect(asset.headers.get('x-frame-options')).toBe('DENY')
    const route = await fetch(`${s.origin}/portal/settings`)
    expect(await route.text()).toContain('<title>app</title>')
    expect(await (await fetch(`${s.origin}/health`)).json()).toEqual({ ok: true })
    await s.stop()
  })

  it('does not serve a file from outside its directory', async () => {
    const dir = staticDir()
    writeFileSync(join(dir, '..', 'outside-secret.txt'), 'do-not-serve')
    const s = await start({ dir })
    for (const path of ['/../outside-secret.txt', '/%2e%2e/outside-secret.txt', '/..%2foutside-secret.txt']) {
      const body = await (await fetch(`${s.origin}${path}`)).text()
      expect(body, path).not.toContain('do-not-serve')
    }
    await s.stop()
  })

  it('has no setup page and no single sign-on routes', async () => {
    const s = await start()
    for (const path of ['/setup', '/auth/start', '/auth/saml', '/auth/callback', '/scim/v2/Users']) {
      const res = await fetch(`${s.origin}${path}`, { method: 'POST' })
      expect(res.status, path).toBe(404)
    }
    await s.stop()
  })

  it('tells the app to use password sign-in, and cannot be made to carry markup', () => {
    const window = {}
    runInNewContext(runtimeConfigScript({ origin: 'https://ehs.test/</script><b>' }), { window })
    expect(window.__OHSMS_CONFIG__.AUTH_METHOD).toBe('password')
    expect(runtimeConfigScript({ origin: 'https://ehs.test/</script>' })).not.toMatch(/</)
  })
})

describe('an administrator password chosen by the operator', () => {
  it('signs straight in without a forced change when ADMIN_MUST_CHANGE is false', async () => {
    const s = await start({
      bootstrap: {
        orgName: 'Cult Fit',
        adminEmail: ADMIN.email,
        adminPassword: 'Chosen*Pass*123',
        mustChange: false,
      },
    })
    const token = await s.signIn(ADMIN.email, 'Chosen*Pass*123')
    expect(await s.read(token, 'organization', 'profile')).toMatchObject({ name: 'Cult Fit' })
    await s.stop()
  })
})
