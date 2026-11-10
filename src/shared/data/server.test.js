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

async function start({ db, dir = '', bootstrap, mail, fetchImpl, blobDir = '' } = {}) {
  const database = db || (await hostedLikeDb())
  const app = await createDedicatedApp({
    db: database,
    origin: 'https://ehs.example.com',
    sessionSecret: SECRET,
    dataKeyMaster: Buffer.alloc(32, 7).toString('base64'),
    staticDir: dir,
    mail,
    fetchImpl,
    blobDir,
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

  // Any session could send any text to any address from the organization's
  // own sending domain through this job. It had no caller; it is gone.
  it('has no job that sends mail on the caller\'s say-so', async () => {
    const sent = []
    const s = await start({ mail: async (m) => sent.push(m) })
    const admin = await readyAdmin(s)
    const res = await s.rpc(admin, 'notifyIncidentReported', {
      to: 'anyone@example.test',
      subject: 'x',
      text: 'y',
    })
    expect(res.status).toBe(404)
    expect(sent).toEqual([])
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

describe('site weather', () => {
  it('answers for a site the caller can see, through the server, and refuses others', async () => {
    const asked = []
    const NOW = Date.now()
    const ts = [NOW - 3_600_000, NOW - 60_000, NOW + 3_600_000]
    const ok = (json) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => json, text: async () => '' })
    const fetchImpl = async (url) => {
      asked.push(String(url))
      if (String(url).includes('air-quality')) return ok({ hourly: { time: [NOW - 60_000], us_aqi: [40] } })
      const fill = (v) => ts.map(() => v)
      return ok({
        hourly: {
          time: ts,
          temperature_2m: fill(29),
          relative_humidity_2m: fill(60),
          precipitation: fill(0),
          cape: fill(0),
          weather_code: fill(0),
          wind_speed_10m: fill(1),
        },
      })
    }
    const s = await start({ fetchImpl })
    const admin = await readyAdmin(s)
    await s.post(
      '/data',
      { op: 'commit', ops: [{ type: 'set', path: 'sites', id: 'w1', merge: false, data: { name: 'Depot', lat: 19.08, lng: 72.88 } }] },
      admin
    )
    const here = await s.rpc(admin, 'fetchSiteWeather', { lat: 19.08, lng: 72.88 })
    expect(here.status).toBe(200)
    expect(here.body.obs.tempC).toBe(29)
    const elsewhere = await s.rpc(admin, 'fetchSiteWeather', { lat: 51.5, lng: -0.12 })
    expect(elsewhere.status).toBe(403)
    // The cached reading is the server's: the data API neither shows nor takes it.
    const cache = await s.post('/data', { op: 'list', path: 'weatherCache' }, admin)
    expect(cache.body.rows).toEqual([])
    const poison = await s.post(
      '/data',
      { op: 'commit', ops: [{ type: 'set', path: 'weatherCache', id: 'om_19.08_72.88', merge: false, data: { slot: 'x', obs: { tempC: 99 } } }] },
      admin
    )
    expect(poison.status).toBe(403)
    expect(asked.every((u) => u.startsWith('https://api.open-meteo.com/') || u.startsWith('https://air-quality-api.open-meteo.com/'))).toBe(true)
    await s.stop()
  })
})

describe('subject access export', () => {
  it('gathers a person\'s records for a manager, and refuses everyone else', async () => {
    const s = await start()
    const admin = await readyAdmin(s)
    const made = await s.rpc(admin, 'createMember', {
      email: 'sam@cult.test',
      name: 'Sam',
      role: 'member',
      password: 'temporary-pass-9',
    })
    const sam = made.body.uid
    const commit = (ops) => s.post('/data', { op: 'commit', ops }, admin)
    // An open general shift, as the form would set it.
    const startMs = Date.now() - 600000
    const shift = {
      shift: 'general',
      windowStart: { __ohsms: 'ts', s: Math.floor(startMs / 1000), ns: 0 },
      windowEnd: { __ohsms: 'ts', s: Math.floor(startMs / 1000) + 9 * 3600, ns: 0 },
    }
    await commit([
      { type: 'set', path: 'trainingAssignments', id: 't1', merge: false, data: { employeeUid: sam, courseName: 'Fire' } },
      { type: 'set', path: 'trainingAssignments', id: 't2', merge: false, data: { employeeUid: 'someone-else' } },
      { type: 'set', path: 'lotoPermits', id: 'lp1', merge: false, data: { ...shift, status: 'requested', requestedBy: sam, personnelUids: [sam] } },
      { type: 'set', path: 'lotoPermits', id: 'lp2', merge: false, data: { ...shift, status: 'requested', requestedBy: 'x', personnelUids: ['y', sam] } },
      { type: 'set', path: 'injuries', id: 'inj1', merge: false, data: { personId: 'P-7', status: 'open' } },
    ])

    const out = await s.rpc(admin, 'exportSubjectData', { uid: sam, personId: 'P-7' })
    expect(out.status).toBe(200)
    expect(out.body.records.users.map((r) => r.id)).toEqual([sam])
    expect(out.body.records.trainingAssignments.map((r) => r.id)).toEqual(['t1'])
    // Matched by either join, listed once.
    expect(out.body.records.lotoPermits.map((r) => r.id).sort()).toEqual(['lp1', 'lp2'])
    expect(out.body.records.injuries.map((r) => r.id)).toEqual(['inj1'])
    // The half it cannot search is named, not reported as "nothing found".
    expect(out.body.mentions.length).toBeGreaterThan(0)
    expect(out.body.problems).toEqual([])

    // An employee cannot assemble a colleague's record, not even their own way round.
    await s.rpc(await s.signIn('sam@cult.test', 'temporary-pass-9'), 'completePasswordChange', {
      current: 'temporary-pass-9',
      password: 'sam-own-pass-10',
    })
    const samToken = await s.signIn('sam@cult.test', 'sam-own-pass-10')
    expect((await s.rpc(samToken, 'exportSubjectData', { uid: sam })).status).toBe(403)
    // Ids are checked before anything is read.
    expect((await s.rpc(admin, 'exportSubjectData', { uid: '../users' })).status).toBe(403)
    expect((await s.rpc(admin, 'exportSubjectData', { uid: 'nobody-here' })).status).toBe(403)
    await s.stop()
  })
})

describe('legacy Firebase files', () => {
  it('copies files off Firebase Storage for an admin, and points the records at the copies', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const blobDir = await mkdtemp(join(tmpdir(), 'ohsms-legacy-'))
    const FB = 'https://firebasestorage.googleapis.com/v0/b/x/o/orgs%2Fa%2Fcrack.jpg?alt=media&token=t1'
    const asked = []
    const fetchImpl = async (url, init) => {
      asked.push({ url: String(url), redirect: init?.redirect })
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'Content-Type': 'image/jpeg' } })
    }
    const s = await start({ fetchImpl, blobDir })
    const admin = await readyAdmin(s)
    await s.post(
      '/data',
      { op: 'commit', ops: [
        { type: 'set', path: 'incidents', id: 'old1', merge: false, data: { title: 'Old', photo: { url: FB, path: 'orgs/a/crack.jpg' } } },
        { type: 'set', path: 'incidents', id: 'old2', merge: false, data: { title: 'Planted', photo: { url: 'https://firebasestorage.googleapis.com.evil.test/x' } } },
      ] },
      admin
    )
    const check = await s.rpc(admin, 'migrateLegacyFiles', { dryRun: true })
    expect(check.body).toMatchObject({ records: 1, files: 1, remaining: 1 })
    expect(asked).toEqual([])

    const run = await s.rpc(admin, 'migrateLegacyFiles', { dryRun: false })
    expect(run.body).toMatchObject({ copied: 1, failed: [], remaining: 0 })
    // Only the Firebase host, and no redirect followed.
    expect(asked).toEqual([{ url: FB, redirect: 'error' }])
    const rec = await s.read(admin, 'incidents', 'old1')
    expect(rec.photo.url.startsWith('https://ehs.example.com/blob?')).toBe(true)
    expect(rec.photo.path.startsWith('files/legacy/')).toBe(true)
    // A second run has nothing left to do.
    expect((await s.rpc(admin, 'migrateLegacyFiles', { dryRun: true })).body.files).toBe(0)

    const made = await s.rpc(admin, 'createMember', { email: 'lf@cult.test', role: 'manager', password: 'temporary-pass-9' })
    await s.rpc(await s.signIn('lf@cult.test', 'temporary-pass-9'), 'completePasswordChange', { current: 'temporary-pass-9', password: 'lf-own-pass-10' })
    const mgr = await s.signIn('lf@cult.test', 'lf-own-pass-10')
    expect(made.body.ok).toBe(true)
    expect((await s.rpc(mgr, 'migrateLegacyFiles', { dryRun: true })).status).toBe(403)
    await s.stop()
  })
})

describe('fresh download links', () => {
  it('issues a link to a signed-in person, never for medical files to an employee', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const s = await start({ blobDir: await mkdtemp(join(tmpdir(), 'ohsms-dl-')) })
    const admin = await readyAdmin(s)
    await s.rpc(admin, 'createMember', { email: 'dl@cult.test', role: 'member', password: 'temporary-pass-9' })
    await s.rpc(await s.signIn('dl@cult.test', 'temporary-pass-9'), 'completePasswordChange', { current: 'temporary-pass-9', password: 'dl-own-pass-10' })
    const emp = await s.signIn('dl@cult.test', 'dl-own-pass-10')

    const ok = await s.post('/presign', { op: 'get', path: 'files/incident-photos/a.jpg' }, emp)
    expect(ok.status).toBe(200)
    expect(ok.body.url).toMatch(/\/blob\?op=get&path=.*&exp=\d+&sig=/)
    for (const path of ['files/medical-records/fit-note.pdf', 'files/illness-files/x.pdf']) {
      expect((await s.post('/presign', { op: 'get', path }, emp)).status, path).toBe(403)
      expect((await s.post('/presign', { op: 'get', path }, admin)).status, path).toBe(200)
    }
    expect((await s.post('/presign', { op: 'get', path: 'files/a/b.jpg' })).status).toBe(401)
    expect((await s.post('/presign', { op: 'get', path: 'secrets/x' }, admin)).status).toBe(403)
    await s.stop()
  })
})

describe('records leave with fresh download links', () => {
  it('re-signs a stored link that has expired or never expired', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const s = await start({ blobDir: await mkdtemp(join(tmpdir(), 'ohsms-rs-')) })
    const admin = await readyAdmin(s)
    const stale = 'https://ehs.example.com/blob?op=get&path=files%2Fincident-photos%2Fa.jpg&sig=never-expired'
    await s.post('/data', { op: 'commit', ops: [{ type: 'set', path: 'incidents', id: 'rs1', merge: false, data: { photo: { url: stale, path: 'files/incident-photos/a.jpg' } } }] }, admin)
    const got = await s.read(admin, 'incidents', 'rs1')
    expect(got.photo.url).not.toBe(stale)
    expect(got.photo.url).toMatch(/^https:\/\/ehs\.example\.com\/blob\?op=get&path=files%2Fincident-photos%2Fa\.jpg&exp=\d+&sig=/)
    const listed = (await s.post('/data', { op: 'list', path: 'incidents' }, admin)).body.rows
    expect(listed.find((r) => r.id === 'rs1').photo.url).toBe(got.photo.url)
    await s.stop()
  })
})
