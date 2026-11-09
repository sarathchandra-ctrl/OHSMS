// The organization's server as deployed (stack/app.mjs), on PGlite.
//
// These set it up through /setup, restart it and check what came back, read
// the state table to check what is NOT in it, and try the doors a deployment
// must keep shut: the demo OIDC issuer, a wrong state key, the removed
// multi-company routes, and a path out of the static directory.
import { PGlite } from '@electric-sql/pglite'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createDedicatedApp, runtimeConfigScript } from '../../../stack/app.mjs'
import { runInNewContext } from 'node:vm'
import { makeIdpKeys, readAuthnRequest, signedResponse } from '../../../e2e/support/samlIdp.mjs'

const OPERATOR = 'operator-token-for-the-test-0123456789'
const request = {
  id: 'reqDedicated01',
  status: 'requested',
  orgName: 'Northwind Metals',
  address: 'Pune',
  contactName: 'Asha Rao',
  contactEmail: 'asha@northwind.test',
  handoffContact: 'asha@northwind.test',
  mode: 'bring',
  engine: 'postgres',
  authMethod: 'saml',
  authIssuer: 'https://idp.northwind.test/saml',
  authClientId: 'ohsms-northwind',
  bucketMode: 'provision',
  presignUrl: '',
}
const DB_URL = 'postgres://ehs_browser@db.northwind.internal:5432/ehs'
const MASTER = 'nw-dkm-' + 'a'.repeat(40)

function staticDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dedicated-app-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>')
  writeFileSync(join(dir, 'assets', 'main-abc.js'), 'console.log(1)')
  return dir
}

async function start(db, { stateKey, dir = '' } = {}) {
  const app = await createDedicatedApp({
    db,
    stateKey,
    origin: 'http://127.0.0.1',
    sessionSecret: 's'.repeat(40),
    controlToken: OPERATOR,
    dataKeyMaster: 'm'.repeat(40),
    mail: null,
    staticDir: dir,
  })
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${app.server.address().port}`
  const stop = () => new Promise((resolve) => app.server.close(resolve))
  return { ...app, origin, stop }
}

// First-run setup, as the installer does it in the browser: the organization,
// its first administrator and the company SAML sign-in, in one form.
async function setupSaml(origin, { samlIdpCert, samlEntryPoint }) {
  return fetch(`${origin}/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: OPERATOR,
      orgName: request.orgName,
      address: request.address,
      contactName: request.contactName,
      contactEmail: request.contactEmail,
      method: 'saml',
      samlEntryPoint,
      samlIdpCert,
    }).toString(),
  })
}

async function fileAndHandOff(origin, secrets) {
  const intake = await setupSaml(origin, secrets)
  return { intake }
}

describe('dedicated environment across a restart', () => {
  it('keeps the connected SAML sign-in and stays set up', async () => {
    const db = new PGlite()
    const stateKey = randomBytes(32)
    const keys = makeIdpKeys('northwind-idp')
    const first = await start(db, { stateKey })
    const { token, intake } = await fileAndHandOff(first.origin, {
      databaseUrl: DB_URL,
      dataKeyMaster: MASTER,
      samlIdpCert: keys.cert,
      samlEntryPoint: 'https://idp.northwind.test/sso',
    })
    expect(intake.status).toBe(200)
    await first.stop()

    // A new process on the same database keeps the connected sign-in, and
    // /setup stays closed: the organization exists.
    const second = await start(db, { stateKey })
    expect(second.state.auth).toMatchObject({ method: 'saml' })
    const signIn = await fetch(`${second.origin}/auth/start`, { redirect: 'manual' })
    expect(signIn.status).toBe(302)
    expect(signIn.headers.get('location')).toMatch(/^https:\/\/idp\.northwind\.test\/sso\?/)
    const again = await setupSaml(second.origin, {
      samlIdpCert: 'x',
      samlEntryPoint: 'https://attacker.test/sso',
    })
    expect(again.status).toBe(409)
    await second.stop()
  })

  it('stores no secret readable without the key', async () => {
    const db = new PGlite()
    const keys = makeIdpKeys('northwind-idp')
    const app = await start(db, { stateKey: randomBytes(32) })
    await fileAndHandOff(app.origin, {
      databaseUrl: DB_URL,
      dataKeyMaster: MASTER,
      samlIdpCert: keys.cert,
      samlEntryPoint: 'https://idp.northwind.test/sso',
    })
    await app.stop()
    const dump = JSON.stringify((await db.query('SELECT * FROM control_state')).rows)
    expect(dump).toContain('sealed') // the sign-in row is there, sealed
    for (const secret of [keys.cert.split('\n')[1], 'idp.northwind.test/sso']) {
      expect(dump).not.toContain(secret)
    }
  })

  it('refuses to start with a different state key rather than forget the secrets', async () => {
    const db = new PGlite()
    const app = await start(db, { stateKey: randomBytes(32) })
    const keys = makeIdpKeys('northwind-idp')
    await fileAndHandOff(app.origin, {
      samlIdpCert: keys.cert,
      samlEntryPoint: 'https://idp.northwind.test/sso',
    })
    await app.stop()
    await expect(start(db, { stateKey: randomBytes(32) })).rejects.toThrow()
  })
})

describe('doors a deployment keeps shut', () => {
  it('serves no demo OIDC issuer, and refuses sign-in before a handoff names an IdP', async () => {
    const app = await start(new PGlite(), { stateKey: randomBytes(32) })
    for (const path of [
      '/oidc/authorize',
      '/oidc/token',
      '/oidc/userinfo',
      '/.well-known/openid-configuration',
    ]) {
      const res = await fetch(`${app.origin}${path}`, {
        method: path === '/oidc/token' ? 'POST' : 'GET',
      })
      expect(res.status, path).toBe(404)
    }
    const signIn = await fetch(`${app.origin}/auth/start`, { redirect: 'manual' })
    expect(signIn.status).toBe(503)
    await app.stop()
  })

  it('has no multi-company provisioning routes', async () => {
    const app = await start(new PGlite(), { stateKey: randomBytes(32) })
    for (const path of ['/requests', '/intake', '/intake/start', '/fulfill', '/handoff']) {
      const res = await fetch(`${app.origin}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR}` },
        body: JSON.stringify(request),
      })
      expect(res.status, path).toBe(404)
    }
    await app.stop()
  })
})

describe('serving the built app', () => {
  it('serves files, falls back to the app for client routes, and keeps the API', async () => {
    const dir = staticDir()
    const app = await start(new PGlite(), { stateKey: randomBytes(32), dir })
    const asset = await fetch(`${app.origin}/assets/main-abc.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect(asset.headers.get('x-frame-options')).toBe('DENY')
    const route = await fetch(`${app.origin}/portal/settings`)
    expect(await route.text()).toContain('<title>app</title>')
    expect(route.headers.get('cache-control')).toBe('no-cache')
    const health = await fetch(`${app.origin}/health`)
    expect(await health.json()).toEqual({ ok: true })
    await app.stop()
  })

  it('does not serve a file from outside its directory', async () => {
    const dir = staticDir()
    writeFileSync(join(dir, '..', 'outside-secret.txt'), 'do-not-serve')
    const app = await start(new PGlite(), { stateKey: randomBytes(32), dir })
    for (const path of [
      '/../outside-secret.txt',
      '/%2e%2e/outside-secret.txt',
      '/assets/%2e%2e/%2e%2e/outside-secret.txt',
      '/..%2foutside-secret.txt',
    ]) {
      const body = await (await fetch(`${app.origin}${path}`)).text()
      expect(body, path).not.toContain('do-not-serve')
    }
    await app.stop()
  })
})

// A managed Postgres (Cloud SQL, Supabase, Neon…) gives no SUPERUSER. PGlite
// does, and running as superuser hid three bugs that each broke the deployed
// environment outright: the schema could not create its roles, every member
// read recursed through the SECURITY DEFINER helpers, and fulfillment's
// invite insert was refused by FORCE ROW LEVEL SECURITY. This runs the whole
// path on a PGlite set up the way a managed database is: the roles made once
// by an administrator, and the app connected as an ordinary owner.
async function managedLikeDb() {
  const db = new PGlite()
  await db.exec(`
    CREATE ROLE ohsms_browser NOLOGIN;
    CREATE ROLE ohsms_worker NOLOGIN BYPASSRLS;
    CREATE ROLE app NOLOGIN;
    GRANT ohsms_browser, ohsms_worker TO app;
    ALTER SCHEMA public OWNER TO app;
    SET ROLE app;
  `)
  const who = await db.query(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
  )
  expect(who.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
  return db
}

describe('on a database where the app is not a superuser', () => {
  it('provisions, survives a restart, signs the founder in and serves their records', async () => {
    const db = await managedLikeDb()
    const stateKey = randomBytes(32)
    const keys = makeIdpKeys('northwind-idp')
    const first = await start(db, { stateKey })
    const { intake } = await fileAndHandOff(first.origin, {
      databaseUrl: DB_URL,
      dataKeyMaster: MASTER,
      samlIdpCert: keys.cert,
      samlEntryPoint: 'https://idp.northwind.test/sso',
    })
    expect(intake.status).toBe(200)
    await first.stop()

    const app = await start(db, { stateKey })
    const begin = await fetch(`${app.origin}/auth/start`, { redirect: 'manual' })
    const cookie = String(begin.headers.get('set-cookie')).split(';')[0]
    const authn = readAuthnRequest(
      new URL(begin.headers.get('location')).searchParams.get('SAMLRequest')
    )
    const acs = await fetch(`${app.origin}/auth/saml`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({
        SAMLResponse: signedResponse({
          keys,
          request: authn,
          idpEntityId: 'https://idp.northwind.test/saml',
          email: request.contactEmail,
          name: 'Asha Rao',
        }),
      }).toString(),
    })
    expect(acs.status).toBe(302)
    const session = decodeURIComponent(acs.headers.get('location').split('#session=')[1])

    const read = (path, id) =>
      fetch(`${app.origin}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
        body: JSON.stringify({ op: 'get', path, id }),
      }).then((r) => r.json())
    const me = await read('users', request.contactEmail)
    expect(me.doc).toMatchObject({ role: 'admin', status: 'approved' })
    expect((await read('organization', 'profile')).doc).toMatchObject({
      name: 'Northwind Metals',
    })
    await app.stop()
  })
})

// ── Inviting people ─────────────────────────────────────────────────────────
// Until invites, only the founder could ever sign in. These go through the
// real host on a managed-shaped database: the founder invites, the invitee
// signs in with the company IdP, and everyone who should not be able to add
// people — a member, a stranger, another tenant's admin — tries anyway.

async function signIn(origin, keys, email, shape = {}) {
  const begin = await fetch(`${origin}/auth/start`, { redirect: 'manual' })
  const cookie = String(begin.headers.get('set-cookie')).split(';')[0]
  const authn = readAuthnRequest(
    new URL(begin.headers.get('location')).searchParams.get('SAMLRequest')
  )
  const acs = await fetch(`${origin}/auth/saml`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({
      SAMLResponse: signedResponse({
        keys,
        request: authn,
        idpEntityId: 'https://idp.northwind.test/saml',
        email,
        name: email,
        ...shape,
      }),
    }).toString(),
  })
  const location = acs.headers.get('location') || ''
  return {
    status: acs.status,
    session: location.includes('#session=')
      ? decodeURIComponent(location.split('#session=')[1])
      : '',
  }
}

async function liveEnvironment() {
  const db = await managedLikeDb()
  const keys = makeIdpKeys('northwind-idp')
  const app = await start(db, { stateKey: randomBytes(32) })
  await fileAndHandOff(app.origin, {
    databaseUrl: DB_URL,
    dataKeyMaster: MASTER,
    samlIdpCert: keys.cert,
    samlEntryPoint: 'https://idp.northwind.test/sso',
  })
  const founder = await signIn(app.origin, keys, request.contactEmail)
  expect(founder.status).toBe(302)
  const rpc = (session, name, body = {}) =>
    fetch(`${app.origin}/rpc/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session ? { Authorization: `Bearer ${session}` } : {}),
      },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }))
  const read = (session, path, id) =>
    fetch(`${app.origin}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
      body: JSON.stringify({ op: 'get', path, id }),
    }).then((r) => r.json())
  return { db, keys, app, founder: founder.session, rpc, read }
}

describe('inviting people to a dedicated environment', () => {
  it('lets the founder invite someone who then signs in with the invited role', async () => {
    const env = await liveEnvironment()
    const invited = await env.rpc(env.founder, 'inviteMember', {
      email: 'Ravi@Northwind.test',
      role: 'manager',
      name: 'Ravi Nair',
    })
    expect(invited).toMatchObject({ status: 200, body: { ok: true, email: 'ravi@northwind.test' } })

    const listed = await env.rpc(env.founder, 'listInvites')
    expect(listed.body.invites).toEqual([
      { email: 'ravi@northwind.test', role: 'manager', name: 'Ravi Nair' },
    ])

    const { session } = await signIn(env.app.origin, env.keys, 'ravi@northwind.test')
    expect(session).not.toBe('')
    const me = await env.read(session, 'users', 'ravi@northwind.test')
    expect(me.doc).toMatchObject({
      role: 'manager',
      status: 'approved',
    })
    // The invite is spent by the sign-in.
    expect((await env.rpc(env.founder, 'listInvites')).body.invites).toEqual([])
    await env.app.stop()
  })

  it('still refuses anyone the IdP knows but nobody invited', async () => {
    const env = await liveEnvironment()
    const stranger = await signIn(env.app.origin, env.keys, 'contractor@northwind.test')
    expect(stranger).toEqual({ status: 403, session: '' })
    await env.app.stop()
  })

  it('refuses a member, a signed-out caller and a forged session', async () => {
    const env = await liveEnvironment()
    await env.rpc(env.founder, 'inviteMember', { email: 'mo@northwind.test', role: 'member' })
    const member = (await signIn(env.app.origin, env.keys, 'mo@northwind.test')).session
    const attempt = { email: 'friend@elsewhere.test', role: 'admin' }
    for (const session of [member, '', env.founder.slice(0, -4) + 'AAAA']) {
      for (const name of ['inviteMember', 'listInvites', 'revokeInvite']) {
        const res = await env.rpc(session, name, attempt)
        expect(res.status, `${name} with ${session ? 'a session' : 'none'}`).toBe(403)
        expect(res.body).toEqual({ ok: false, reason: 'not-admin' })
      }
    }
    await env.app.stop()
  })

  it('stops an admin the moment they are demoted, whatever their session says', async () => {
    const env = await liveEnvironment()
    await env.rpc(env.founder, 'inviteMember', { email: 'ada@northwind.test', role: 'admin' })
    const ada = (await signIn(env.app.origin, env.keys, 'ada@northwind.test')).session
    expect((await env.rpc(ada, 'listInvites')).status).toBe(200)
    // Demoted by the founder (as the Employees page does), same session.
    const demote = await fetch(`${env.app.origin}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.founder}` },
      body: JSON.stringify({
        op: 'commit',
        ops: [
          { type: 'update', path: 'users', id: 'ada@northwind.test', data: { role: 'member' } },
        ],
      }),
    })
    expect(demote.status).toBe(200)
    const after = await env.rpc(ada, 'inviteMember', { email: 'x@northwind.test', role: 'admin' })
    expect(after).toEqual({ status: 403, body: { ok: false, reason: 'not-admin' } })
    await env.app.stop()
  })

  it('refuses a role the product does not have, and a malformed address', async () => {
    const env = await liveEnvironment()
    for (const [body, reason] of [
      [{ email: 'a@northwind.test', role: 'superadmin' }, 'role'],
      [{ email: 'a@northwind.test', role: 'Admin' }, 'role'],
      [{ email: 'a@northwind.test' }, 'role'],
      [{ email: 'not-an-address', role: 'member' }, 'email'],
      [{ email: 'a@b.test\r\nBcc: x@y.test', role: 'member' }, 'email'],
      [{ email: ['a@northwind.test'], role: 'member' }, 'email'],
    ]) {
      expect((await env.rpc(env.founder, 'inviteMember', body)).body).toEqual({
        ok: false,
        reason,
      })
    }
    await env.app.stop()
  })

  it('will not re-invite an existing member, so a role is not changed by invitation', async () => {
    const env = await liveEnvironment()
    const res = await env.rpc(env.founder, 'inviteMember', {
      email: request.contactEmail.toUpperCase(),
      role: 'auditor',
    })
    expect(res.body).toEqual({ ok: false, reason: 'already-member' })
    await env.app.stop()
  })

  it('withdraws an invite so that person can no longer sign in', async () => {
    const env = await liveEnvironment()
    await env.rpc(env.founder, 'inviteMember', { email: 'temp@northwind.test', role: 'member' })
    const revoked = await env.rpc(env.founder, 'revokeInvite', { email: 'TEMP@northwind.test' })
    expect(revoked.body).toEqual({ ok: true, removed: true })
    expect((await signIn(env.app.origin, env.keys, 'temp@northwind.test')).status).toBe(403)
    await env.app.stop()
  })
})

// ── One image for every company ─────────────────────────────────────────────
function configFrom(script) {
  const window = {}
  runInNewContext(script, { window })
  return window.__OHSMS_CONFIG__
}

describe('the settings a dedicated host gives the app', () => {
  it('follows setup: no sign-in before it, the connected IdP after', async () => {
    const db = new PGlite()
    const keys = makeIdpKeys('northwind-idp')
    const app = await start(db, { stateKey: randomBytes(32) })
    const before = await fetch(`${app.origin}/runtime-config.js`)
    expect(before.headers.get('cache-control')).toBe('no-store')
    expect(configFrom(await before.text())).toEqual({
      DATA_DRIVER: 'postgres',
      DATA_GATEWAY: 'http://127.0.0.1',
      STORAGE_DRIVER: 's3',
      S3_PRESIGN_ENDPOINT: 'http://127.0.0.1/presign',
      AUTH_METHOD: 'none',
      AUTH_TOTP: 'off',
    })
    await fileAndHandOff(app.origin, {
      databaseUrl: DB_URL,
      dataKeyMaster: MASTER,
      samlIdpCert: keys.cert,
      samlEntryPoint: 'https://idp.northwind.test/sso',
    })
    const after = configFrom(await (await fetch(`${app.origin}/runtime-config.js`)).text())
    expect(after.AUTH_METHOD).toBe('saml')
    await app.stop()
  })

  it('cannot be made to close the script or carry markup', () => {
    const script = runtimeConfigScript({
      origin: 'https://ehs.test/</script><img src=x onerror=alert(1)>',
      auth: { method: '</script>' },
    })
    expect(script).not.toMatch(/</)
    const config = configFrom(script)
    expect(config.AUTH_METHOD).toBe('none')
  })
})

// ── First-run setup in the browser ──────────────────────────────────────────
// The installer connects the organization at /setup with the setup code, no
// curl and no handoff link. It must refuse a wrong code, never echo a secret,
// make exactly one organization, and close once that organization is live.
describe('setting up in the browser', () => {
  const form = (fields) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
  const saml = (keys, extra = {}) => ({
    code: OPERATOR,
    orgName: 'Northwind Metals',
    address: 'Pune',
    contactName: 'Asha Rao',
    contactEmail: 'Asha@Northwind.test',
    method: 'saml',
    samlEntryPoint: 'https://idp.northwind.test/sso',
    samlIdpCert: keys.cert,
    ...extra,
  })

  it('takes the organization and its SAML sign-in, then the founder signs in', async () => {
    const keys = makeIdpKeys('northwind-idp')
    const app = await start(await managedLikeDb(), { stateKey: randomBytes(32) })

    const page = await fetch(`${app.origin}/setup`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('Set up WEEHS')
    expect(html).toContain('http://127.0.0.1/auth/saml')

    const done = await fetch(`${app.origin}/setup`, form(saml(keys)))
    expect(done.status).toBe(200)
    const doneHtml = await done.text()
    expect(doneHtml).toContain('Northwind Metals is live')
    expect(doneHtml).not.toContain(OPERATOR)
    expect(doneHtml).not.toContain(keys.cert.replace(/-----[A-Z ]+-----|\s/g, '').slice(20, 80))

    // The app is told about the sign-in, and the founder is its admin.
    const config = configFrom(await (await fetch(`${app.origin}/runtime-config.js`)).text())
    expect(config.AUTH_METHOD).toBe('saml')
    const founder = await signIn(app.origin, keys, 'asha@northwind.test')
    expect(founder.status).toBe(302)
    expect(founder.session).not.toBe('')

    // Closed from now on, whoever knows the code.
    expect(await (await fetch(`${app.origin}/setup`)).text()).toContain('Already set up')
    const again = await fetch(`${app.origin}/setup`, form(saml(keys, { orgName: 'Second Org' })))
    expect(again.status).toBe(409)
    await app.stop()
  })

  it('refuses a wrong code without echoing anything secret, and stops answering after ten', async () => {
    const keys = makeIdpKeys('northwind-idp')
    const app = await start(await managedLikeDb(), { stateKey: randomBytes(32) })
    const wrong = await fetch(`${app.origin}/setup`, form(saml(keys, { code: 'not-the-code' })))
    expect(wrong.status).toBe(403)
    const html = await wrong.text()
    expect(html).toContain('setup code is not right')
    expect(html).not.toContain(keys.cert.replace(/-----[A-Z ]+-----|\s/g, '').slice(20, 80))
    expect(html).not.toContain('not-the-code')
    // Public values are kept so the form need not be typed again.
    expect(html).toContain('value="Northwind Metals"')

    for (let i = 0; i < 9; i += 1) {
      await fetch(`${app.origin}/setup`, form(saml(keys, { code: `guess-${i}` })))
    }
    // Even the right code is refused while the window is full.
    const locked = await fetch(`${app.origin}/setup`, form(saml(keys)))
    expect(locked.status).toBe(429)
    expect(await (await fetch(`${app.origin}/setup`)).text()).toContain('Set up WEEHS')
    await app.stop()
  })

  it('refuses an incomplete sign-in and leaves the environment open to try again', async () => {
    const keys = makeIdpKeys('northwind-idp')
    const app = await start(await managedLikeDb(), { stateKey: randomBytes(32) })
    const noCert = await fetch(`${app.origin}/setup`, form(saml(keys, { samlIdpCert: '' })))
    expect(noCert.status).toBe(400)
    expect(await noCert.text()).toContain('certificate')
    const http = await fetch(
      `${app.origin}/setup`,
      form(saml(keys, { samlEntryPoint: 'http://idp.northwind.test/sso' }))
    )
    expect(http.status).toBe(400)
    const oidc = await fetch(
      `${app.origin}/setup`,
      form({
        ...saml(keys),
        method: 'oidc',
        authIssuer: 'https://login.northwind.test',
        authClientId: 'c',
      })
    )
    expect(oidc.status).toBe(400)
    expect(await oidc.text()).toContain('client secret')

    const ok = await fetch(`${app.origin}/setup`, form(saml(keys)))
    expect(ok.status).toBe(200)
    await app.stop()
  })
})

// ── Company identity providers that already serve many apps ────────────────
// Microsoft Entra sends SAML in its own shape, and a company of thousands
// cannot be invited one person at a time. These go through the real host.
describe('enterprise identity providers', () => {
  const ENTRA = {
    email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    given: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
    surname: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
  }

  it('matches an Entra SAML user by the email claim, not the UPN in NameID', async () => {
    const { app, keys, founder, rpc, read } = await liveEnvironment()
    const invited = await rpc(founder, 'inviteMember', {
      email: 'ravi@northwind.test',
      role: 'member',
    })
    expect(invited.status).toBe(200)
    const ravi = await signIn(app.origin, keys, 'ravi@northwind.test', {
      nameId: 'rkumar@northwindcorp.onmicrosoft.com',
      attributes: {
        [ENTRA.email]: 'ravi@northwind.test',
        [ENTRA.given]: 'Ravi',
        [ENTRA.surname]: 'Kumar',
      },
    })
    expect(ravi.status).toBe(302)
    const me = await read(ravi.session, 'users', 'rkumar@northwindcorp.onmicrosoft.com')
    expect(me.doc).toMatchObject({
      email: 'ravi@northwind.test',
      name: 'Ravi Kumar',
      role: 'member',
    })
    await app.stop()
  })

  it('lets everyone at the company domain join, with the chosen role, and nobody else', async () => {
    const { app, keys, founder, rpc, read } = await liveEnvironment()
    // Off: no invite, no account.
    expect((await signIn(app.origin, keys, 'nina@northwind.test')).session).toBe('')

    const turnedOn = await rpc(founder, 'setAutoJoin', {
      domains: ['Northwind.test'],
      role: 'member',
    })
    expect(turnedOn.body).toMatchObject({
      ok: true,
      autoJoin: { domains: ['northwind.test'], role: 'member' },
    })
    expect((await rpc(founder, 'getAutoJoin')).body.autoJoin).toEqual({
      domains: ['northwind.test'],
      role: 'member',
    })

    const nina = await signIn(app.origin, keys, 'nina@northwind.test')
    expect(nina.status).toBe(302)
    const me = await read(nina.session, 'users', 'nina@northwind.test')
    expect(me.doc).toMatchObject({ role: 'member', status: 'approved', joinedBy: 'domain' })

    // Another domain, and a domain that merely ends the same way, stay out.
    expect((await signIn(app.origin, keys, 'eve@other.test')).session).toBe('')
    expect((await signIn(app.origin, keys, 'eve@evilnorthwind.test')).session).toBe('')

    // Never admin, and only an admin may change it.
    expect(
      (await rpc(founder, 'setAutoJoin', { domains: ['northwind.test'], role: 'admin' })).body
    ).toMatchObject({
      ok: false,
      reason: 'role',
    })
    expect(
      (await rpc(nina.session, 'setAutoJoin', { domains: ['other.test'], role: 'manager' })).body
    ).toMatchObject({
      ok: false,
      reason: 'not-admin',
    })
    // A typo is refused, not silently dropped.
    expect(
      (
        await rpc(founder, 'setAutoJoin', {
          domains: ['northwind', 'northwind.test'],
          role: 'member',
        })
      ).body
    ).toMatchObject({
      ok: false,
      reason: 'domains',
    })

    // Off again: the next new person needs an invite.
    expect((await rpc(founder, 'setAutoJoin', { domains: [] })).body).toMatchObject({
      ok: true,
      autoJoin: null,
    })
    expect((await signIn(app.origin, keys, 'omar@northwind.test')).session).toBe('')
    await app.stop()
  })

  it('tells the IdP where the app tile should point, and asks about Entra', async () => {
    const app = await start(await managedLikeDb(), { stateKey: randomBytes(32) })
    const html = await (await fetch(`${app.origin}/setup`)).text()
    expect(html).toContain('http://127.0.0.1/auth/start')
    expect(html).toContain('name="entraSingleTenant"')
    await app.stop()
  })
})

// ── The company's directory: groups, deactivation, SCIM ─────────────────────
describe('following the company directory', () => {
  const withGroups = (email, groups) => ({ attributes: { email, displayName: email, groups } })

  it('takes roles from IdP groups at every sign-in, and never removes the last admin', async () => {
    const { app, keys, founder, rpc, read } = await liveEnvironment()
    const rules = [
      { group: 'EHS-Managers', role: 'manager' },
      { group: 'EHS-Admins', role: 'admin' },
    ]
    expect((await rpc(founder, 'setGroupRoles', { rules })).body).toMatchObject({ ok: true, rules })
    expect(
      (await rpc(founder, 'setGroupRoles', { rules: [{ group: '', role: 'member' }] })).body
    ).toMatchObject({
      ok: false,
      reason: 'rules',
    })

    // In a mapped group: joins without an invite, with that group's role.
    const gita = (groups) =>
      signIn(app.origin, keys, 'gita@northwind.test', withGroups('gita@northwind.test', groups))
    let g = await gita(['Everyone', 'EHS-Managers'])
    expect(g.status).toBe(302)
    expect((await read(g.session, 'users', 'gita@northwind.test')).doc).toMatchObject({
      role: 'manager',
      joinedBy: 'groups',
    })
    // Not a member, so not an admin either: she cannot change the rules.
    expect((await rpc(g.session, 'setGroupRoles', { rules: [] })).body.reason).toBe('not-admin')

    // Promoted in the IdP: admin at her next sign-in. No groups sent: unchanged.
    g = await gita(['EHS-Admins', 'EHS-Managers'])
    expect((await read(g.session, 'users', 'gita@northwind.test')).doc.role).toBe('admin')
    g = await gita([])
    expect((await read(g.session, 'users', 'gita@northwind.test')).doc.role).toBe('admin')

    // Two admins: the founder can be moved to manager by her groups...
    const asha = await signIn(
      app.origin,
      keys,
      request.contactEmail,
      withGroups(request.contactEmail, ['EHS-Managers'])
    )
    expect((await read(asha.session, 'users', request.contactEmail)).doc.role).toBe('manager')
    // ...but the last one standing is not, or nobody could administer.
    g = await gita(['EHS-Managers'])
    expect((await read(g.session, 'users', 'gita@northwind.test')).doc.role).toBe('admin')

    // No mapped group, no invite, no domain rule: no account.
    expect(
      (
        await signIn(
          app.origin,
          keys,
          'zed@northwind.test',
          withGroups('zed@northwind.test', ['Everyone'])
        )
      ).session
    ).toBe('')
    await app.stop()
  })

  it('provisions, deactivates, reactivates and deletes people over SCIM', async () => {
    const { app, keys, founder, rpc, read } = await liveEnvironment()
    const scim = (token, method, path, body) =>
      fetch(`${app.origin}/scim/v2${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/scim+json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() }))

    // Only an admin makes a token, and it is shown once.
    expect((await scim('', 'GET', '/Users')).status).toBe(401)
    const created = await rpc(founder, 'createScimToken')
    const token = created.body.token
    expect(token).toMatch(/^weehs_scim_/)
    expect((await rpc(founder, 'scimStatus')).body).toMatchObject({ ok: true, enabled: true })
    expect(JSON.stringify((await rpc(founder, 'scimStatus')).body)).not.toContain(token)
    expect((await scim('weehs_scim_wrong', 'GET', '/Users')).status).toBe(401)
    expect((await scim(token, 'GET', '/ServiceProviderConfig')).body.patch.supported).toBe(true)

    // The directory adds Kiran: an invite, so his first sign-in lets him in.
    const kiran = {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'kiran@northwind.test',
      name: { givenName: 'Kiran', familyName: 'Shah' },
      emails: [{ value: 'Kiran@Northwind.test', primary: true }],
      externalId: 'okta-00u1',
      active: true,
    }
    const made = await scim(token, 'POST', '/Users', kiran)
    expect(made.status).toBe(201)
    const id = made.body.id
    expect((await scim(token, 'POST', '/Users', kiran)).status).toBe(409)
    const found = await scim(
      token,
      'GET',
      `/Users?filter=${encodeURIComponent('userName eq "kiran@northwind.test"')}`
    )
    expect(found.body.totalResults).toBe(1)
    expect((await rpc(founder, 'listInvites')).body.invites.map((i) => i.email)).toContain(
      'kiran@northwind.test'
    )
    let k = await signIn(app.origin, keys, 'kiran@northwind.test')
    expect(k.status).toBe(302)
    const oldSession = k.session
    expect((await read(oldSession, 'users', 'kiran@northwind.test')).doc.status).toBe('approved')

    // Deactivated (Okta's shape): his account is disabled, his open session stops working.
    const off = await scim(token, 'PATCH', `/Users/${id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', value: { active: false } }],
    })
    expect(off.body.active).toBe(false)
    expect((await signIn(app.origin, keys, 'kiran@northwind.test')).status).toBe(403)
    const stillOpen = await read(
      oldSession,
      'organization', 'profile'
    )
    expect(stillOpen.doc ?? null).toBeNull()

    // Reactivated (Entra's shape): in again.
    await scim(token, 'PATCH', `/Users/${id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'active', value: 'True' }],
    })
    k = await signIn(app.origin, keys, 'kiran@northwind.test')
    expect(k.status).toBe(302)

    // Deleted: gone from SCIM, and joining by domain does not let him back.
    expect((await scim(token, 'DELETE', `/Users/${id}`)).status).toBe(204)
    expect((await scim(token, 'GET', `/Users/${id}`)).status).toBe(404)
    await rpc(founder, 'setAutoJoin', { domains: ['northwind.test'], role: 'member' })
    expect((await signIn(app.origin, keys, 'kiran@northwind.test')).status).toBe(403)
    // Someone the directory never deactivated still joins by domain.
    expect((await signIn(app.origin, keys, 'lata@northwind.test')).status).toBe(302)

    // A new token replaces the old; revoking stops it.
    const second = (await rpc(founder, 'createScimToken')).body.token
    expect((await scim(token, 'GET', '/Users')).status).toBe(401)
    expect((await scim(second, 'GET', '/Users')).status).toBe(200)
    await rpc(founder, 'revokeScimToken')
    expect((await scim(second, 'GET', '/Users')).status).toBe(401)
    await app.stop()
  })

  it('takes groups pushed over SCIM: roles change at once, and Entra IDs get names', async () => {
    const { app, keys, founder, rpc, read } = await liveEnvironment()
    const token = (await rpc(founder, 'createScimToken')).body.token
    const scim = (method, path, body) =>
      fetch(`${app.origin}/scim/v2${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/scim+json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() }))
    const patch = (Operations) => ({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations,
    })
    await rpc(founder, 'setGroupRoles', {
      rules: [
        { group: 'Safety-Managers', role: 'manager' },
        { group: 'EHS-Auditors', role: 'auditor' },
      ],
    })

    // Mohan is provisioned and signs in as a member.
    const mohan = (
      await scim('POST', '/Users', {
        userName: 'mohan@northwind.test',
        emails: [{ value: 'mohan@northwind.test', primary: true }],
        active: true,
      })
    ).body.id
    const m = await signIn(app.origin, keys, 'mohan@northwind.test')
    const roleOf = async (email) => (await read(founder, 'users', email)).doc.role
    expect(await roleOf('mohan@northwind.test')).toBe('member')

    // The directory pushes Safety-Managers with Mohan in it: manager now, no sign-in needed.
    const made = await scim('POST', '/Groups', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'Safety-Managers',
      externalId: '5f3c0d2e-entra-object-id',
      members: [{ value: mohan }, { value: 'not-a-user-here' }],
    })
    expect(made.status).toBe(201)
    expect(made.body.members.map((x) => x.value)).toEqual([mohan])
    expect(await roleOf('mohan@northwind.test')).toBe('manager')
    expect((await scim('POST', '/Groups', { displayName: 'Safety-Managers' })).status).toBe(409)
    const listed = await scim(
      'GET',
      `/Groups?filter=${encodeURIComponent('displayName eq "Safety-Managers"')}&excludedAttributes=members`
    )
    expect(listed.body.totalResults).toBe(1)
    expect(listed.body.Resources[0].members).toBeUndefined()

    // Moved to the auditors group the Okta way (remove by filter, add): auditor now.
    const auditors = (await scim('POST', '/Groups', { displayName: 'EHS-Auditors', members: [] }))
      .body.id
    await scim(
      'PATCH',
      `/Groups/${made.body.id}`,
      patch([{ op: 'remove', path: `members[value eq "${mohan}"]` }])
    )
    await scim(
      'PATCH',
      `/Groups/${auditors}`,
      patch([{ op: 'add', path: 'members', value: [{ value: mohan }] }])
    )
    expect(await roleOf('mohan@northwind.test')).toBe('auditor')
    expect(m.status).toBe(302)

    // Entra signs Sara in with the group's object ID; the pushed group names it.
    const sara = await signIn(app.origin, keys, 'sara@northwind.test', {
      attributes: { email: 'sara@northwind.test', groups: ['5f3c0d2e-entra-object-id'] },
    })
    expect(sara.status).toBe(302)
    expect((await read(sara.session, 'users', 'sara@northwind.test')).doc).toMatchObject({
      role: 'manager',
      joinedBy: 'groups',
    })

    // Deleted: the group gives nothing from then on.
    expect((await scim('DELETE', `/Groups/${made.body.id}`)).status).toBe(204)
    expect((await scim('GET', `/Groups/${made.body.id}`)).status).toBe(404)
    const late = await signIn(app.origin, keys, 'tom@northwind.test', {
      attributes: { email: 'tom@northwind.test', groups: ['5f3c0d2e-entra-object-id'] },
    })
    expect(late.session).toBe('')
    await app.stop()
  })

  it('keeps the directory records and token out of the data API', async () => {
    const { app, founder, rpc, read } = await liveEnvironment()
    await rpc(founder, 'createScimToken')
    const token = await read(founder, 'scimTokens')
    expect(token.doc ?? null).toBeNull()
    expect((await rpc(founder, 'createScimToken')).status).toBe(200)
    await app.stop()
  })
})
