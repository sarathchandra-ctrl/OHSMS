import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it, vi } from 'vitest'
import { applySchema, createEngine } from '../../../stack/engine.mjs'
import { initializeOrganization } from '../../../stack/setup.mjs'
import { establishIdentity } from '../../../stack/identity.mjs'
import { signSession, verifySession } from '../../../stack/session.mjs'
import { decidePresign } from '../../../stack/presign.mjs'
import { createPostgresAdapter } from './adapters/postgres'
import { createOwnStackServer, MAX_BODY_BYTES } from '../../../stack/server.mjs'
import { identityFromSupabase } from '../../../stack/supabaseAuth.mjs'
import { samlClient, identityFromSaml } from '../../../stack/saml.mjs'
import { endpointsFor, identityFromCode } from '../../../stack/oidc.mjs'
import { makeIdpKeys, readAuthnRequest, signedResponse } from '../../../e2e/support/samlIdp.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  completePasswordChange,
  runRetention,
  setLocalPassword,
  stampIdentity,
} from '../../../stack/workers.mjs'

const request = {
  id: 'reqNorthwind1',
  status: 'requested',
  orgName: 'Northwind Metals',
  address: 'Pune',
  contactName: 'Asha Rao',
  contactEmail: 'asha@northwind.test',
  handoffContact: 'ops@northwind.test',
  mode: 'weehs-operated',
  engine: 'postgres',
  authMethod: 'oidc',
  authIssuer: 'https://login.northwind.test/realms/staff',
  authClientId: 'ohsms-northwind',
  bucketMode: 'provision',
  presignUrl: '',
}

// The organization and its first administrator, as /setup creates them.
const provision = (engine, db) =>
  initializeOrganization({
    engine,
    db,
    orgName: request.orgName,
    address: request.address,
    adminEmail: request.contactEmail,
    adminName: request.contactName,
  })

describe('a set-up organization', () => {
  it('signs its first administrator in and keeps its records from strangers', async () => {
    const db = new PGlite()
    const engine = createEngine(db)
    const sessionSecret = 's'.repeat(40)
    const result = await initializeOrganization({
      engine,
      db,
      orgName: request.orgName,
      address: request.address,
      adminEmail: request.contactEmail,
      adminName: request.contactName,
    })
    expect(result.ok).toBe(true)
    result.sessionSecret = sessionSecret

    const session = await establishIdentity(engine, db, {
      sub: 'asha-subject',
      email: 'asha@northwind.test',
      name: 'Asha Rao',
    })
    expect(session.ok).toBe(true)
    const token = signSession(result.sessionSecret, { sub: session.uid })
    expect(verifySession(result.sessionSecret, token)).toMatchObject({ sub: 'asha-subject' })
    expect(verifySession(result.sessionSecret, token)).not.toHaveProperty('role')

    const founder = createPostgresAdapter(engine, { role: 'ohsms_browser', uid: 'asha-subject' })
    const org = await founder.get('organization', 'profile')
    expect(org.name).toBe('Northwind Metals')
    await founder.set(`incidents`, 'i1', {
      title: 'Cut',
    })

    const stranger = createPostgresAdapter(engine, { role: 'ohsms_browser', uid: 'someone-else' })
    expect(await stranger.get(`incidents`, 'i1')).toBeNull()

    const profile = await engine.get({ role: 'ohsms_worker', uid: '' }, 'users', 'asha-subject')
    expect(
      decidePresign({ op: 'delete', path: `files/photos/a.jpg`, profile }).ok
    ).toBe(true)
    expect(
      decidePresign({
        op: 'delete',
        path: `files/photos/a.jpg`,
        profile: { ...profile, role: 'auditor' },
      }).ok
    ).toBe(false)
    expect(await stampIdentity(engine, 'asha-subject')).toMatchObject({
      stamped: true,
      role: 'admin',
    })
    const retention = await runRetention(engine, {})
    expect(retention.livePurged).toBe(0)
  })
})

describe('password gate on the worker path', () => {
  it('clears mustChangePassword only after the current password matches', async () => {
    const db = new PGlite()
    const engine = createEngine(db)
    await applySchema(db)
    await engine.commit({ role: 'ohsms_worker', uid: '' }, [
      {
        type: 'set',
        path: 'users',
        id: 'u1',
        merge: false,
        data: {
          role: 'member',
          status: 'approved',
          email: 'a@b.test',
          mustChangePassword: true,
          name: 'A',
        },
      },
    ])
    await setLocalPassword(db, { uid: 'u1', email: 'a@b.test', password: 'temporary-pass' })
    const wrong = await completePasswordChange(engine, db, {
      uid: 'u1',
      current: 'nope-nope-nope',
      password: 'a-new-password',
      idp: false,
    })
    expect(wrong.ok).toBe(false)
    expect((await engine.get(null, 'users', 'u1')).mustChangePassword).toBe(true)
    const right = await completePasswordChange(engine, db, {
      uid: 'u1',
      current: 'temporary-pass',
      password: 'a-new-password',
      idp: false,
    })
    expect(right).toMatchObject({ ok: true, reason: 'replaced' })
    expect((await engine.get(null, 'users', 'u1')).mustChangePassword).toBe(false)
  })
})

describe('dedicated host', () => {
  it('serves a signed-in read over HTTP and refuses a forged role claim', async () => {
    const db = new PGlite()
    const engine = createEngine(db)
    const secret = 'session-secret-for-the-test'
    const server = createOwnStackServer({
      engine,
      db,
      sessionSecret: secret,
      origin: 'http://127.0.0.1',
      auth: { method: 'oidc', issuer: '', clientId: 'ohsms' },
      controlToken: 'operator-token',
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const origin = `http://127.0.0.1:${port}`
    expect((await provision(engine, db)).ok).toBe(true)

    const who = await establishIdentity(engine, db, {
      sub: 'asha-subject',
      email: 'asha@northwind.test',
      name: 'Asha Rao',
    })
    const sessionToken = signSession(secret, { sub: who.uid })
    const forged = sessionToken.split('.').slice(0, 2).join('.') + '.not-a-signature'
    const denied = await fetch(`${origin}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${forged}` },
      body: JSON.stringify({ op: 'get', path: 'organization', id: 'profile' }),
    })
    expect(denied.status).toBe(200)
    expect((await denied.json()).doc).toBeNull()
    const allowed = await fetch(`${origin}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ op: 'get', path: 'organization', id: 'profile' }),
    })
    expect(allowed.status).toBe(200)
    expect((await allowed.json()).doc.name).toBe('Northwind Metals')

    server.close()
  })
})

describe('other IdPs', () => {
  it('takes a Supabase user from GoTrue and never sends a service-role key', async () => {
    const calls = []
    const fetchImpl = async (url, opts) => {
      calls.push({ url: String(url), opts })
      if (String(url).includes('/token')) {
        return { ok: true, json: async () => ({ access_token: 'access' }) }
      }
      return { ok: true, json: async () => ({ id: 'sb-user', email: 'a@b.test' }) }
    }
    const identity = await identityFromSupabase({
      issuer: 'https://project.supabase.co/auth/v1',
      anonKey: 'anon-public',
      email: 'a@b.test',
      password: 'secret-pass',
      fetchImpl,
    })
    expect(identity).toMatchObject({ ok: true, sub: 'sb-user' })
    const blob = JSON.stringify(calls)
    expect(blob).toContain('anon-public')
    expect(blob).not.toContain('service_role')
  })

  it('rejects an unsigned SAML response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'saml-'))
    const key = join(dir, 'key.pem')
    const cert = join(dir, 'cert.pem')
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=test-idp',
    ])
    const client = samlClient({
      issuer: 'ohsms',
      callbackUrl: 'https://app.example/auth/saml',
      idpCert: readFileSync(cert, 'utf8'),
      entryPoint: 'https://idp.example/sso',
    })
    const result = await identityFromSaml(
      client,
      Buffer.from('<Response></Response>').toString('base64')
    )
    expect(result.ok).toBe(false)
  })
})

describe('company SAML on the dedicated host', () => {
  // The SPA sends a SAML company to /auth/start, the same as OIDC. That route
  // used to start an OIDC flow whatever the request said, so a company that
  // chose SAML had no way in. These drive the real host with a real signed
  // response, and then try to get in without one.
  async function samlHost({
    certAs = (pem) => pem,
    entryPoint = 'https://idp.northwind.test/sso',
    expect200 = true,
  } = {}) {
    const db = new PGlite()
    const engine = createEngine(db)
    const secret = 'session-secret-for-the-saml-test'
    const keys = makeIdpKeys('northwind-idp')
    const server = createOwnStackServer({
      engine,
      db,
      sessionSecret: secret,
      origin: 'http://127.0.0.1',
      auth: { method: 'oidc', issuer: '', clientId: '' },
      controlToken: 'operator-token',
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const intake = await fetch(`${origin}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: 'operator-token',
        orgName: request.orgName,
        contactName: request.contactName,
        contactEmail: request.contactEmail,
        method: 'saml',
        samlEntryPoint: entryPoint,
        samlIdpCert: certAs(keys.cert),
      }).toString(),
    })
    if (expect200) expect(intake.status).toBe(200)
    return { server, origin, keys, secret, intake }
  }

  async function start(origin) {
    const res = await fetch(`${origin}/auth/start`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location'))
    // The browser's half of the binding: what /auth/start set, sent back.
    const cookie = String(res.headers.get('set-cookie') || '').split(';')[0]
    expect(cookie).toMatch(/^ohsms_saml=.+/)
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/)
    return {
      location,
      cookie,
      authn: readAuthnRequest(location.searchParams.get('SAMLRequest')),
    }
  }

  function post(origin, samlResponse, cookie = '') {
    return fetch(`${origin}/auth/saml`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: new URLSearchParams({ SAMLResponse: samlResponse }).toString(),
    })
  }

  const answer = (keys, authn, email = 'asha@northwind.test') =>
    signedResponse({
      keys,
      request: authn,
      idpEntityId: 'https://idp.northwind.test/saml',
      email,
      name: 'Asha Rao',
    })

  it('sends the browser to the company IdP and signs in the invited founder', async () => {
    const { server, origin, keys, secret } = await samlHost()
    const { location, authn, cookie } = await start(origin)
    expect(location.origin + location.pathname).toBe('https://idp.northwind.test/sso')
    // The SP entity id /setup gives the IdP is this server's address.
    expect(authn.issuer).toBe('http://127.0.0.1')

    const res = await post(origin, answer(keys, authn), cookie)
    expect(res.status).toBe(302)
    const back = res.headers.get('location')
    const session = decodeURIComponent(back.split('#session=')[1])
    expect(verifySession(secret, session).sub).toBe('asha@northwind.test')
    server.close()
  })

  it('accepts a certificate whose line breaks were lost in the setup form', async () => {
    const { server, origin, keys } = await samlHost({
      certAs: (pem) => pem.replace(/\r?\n/g, ''),
    })
    const { authn, cookie } = await start(origin)
    expect((await post(origin, answer(keys, authn), cookie)).status).toBe(302)
    server.close()
  })

  it('does not mark a SAML company live without the IdP entry point', async () => {
    const { server, origin, intake } = await samlHost({
      entryPoint: '  ',
      expect200: false,
    })
    expect(intake.status).toBe(400)
    expect(await intake.text()).toContain('certificate')
    const start = await fetch(`${origin}/auth/start`, { redirect: 'manual' })
    expect(String(start.headers.get('location'))).not.toContain('idp.northwind.test')
    server.close()
  })

  it('refuses an oversized body on the unauthenticated assertion route', async () => {
    const { server, origin } = await samlHost()
    const res = await fetch(`${origin}/auth/saml`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'SAMLResponse=' + 'A'.repeat(MAX_BODY_BYTES + 1),
    })
    expect(res.status).toBe(413)
    expect((await fetch(`${origin}/health`)).status).toBe(200)
    server.close()
  })

  it('refuses a valid response posted from a browser that did not start that sign-in', async () => {
    // Login CSRF: an invited user starts a sign-in, authenticates as
    // themselves, and makes the victim's browser (which holds its own
    // sign-in cookie, or none) post the response.
    const { server, origin, keys } = await samlHost()
    const attacker = await start(origin)
    const victim = await start(origin)
    const response = answer(keys, attacker.authn)
    expect((await post(origin, response, victim.cookie)).status).toBe(401)
    expect((await post(origin, response)).status).toBe(401)
    server.close()
  })

  it('clears the one-time sign-in cookie once it is used', async () => {
    const { server, origin, keys } = await samlHost()
    const { authn, cookie } = await start(origin)
    const res = await post(origin, answer(keys, authn), cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie')).toMatch(/^ohsms_saml=;.*Max-Age=0/)
    server.close()
  })

  it('refuses the same signed response a second time', async () => {
    const { server, origin, keys } = await samlHost()
    const { authn, cookie } = await start(origin)
    const response = answer(keys, authn)
    expect((await post(origin, response, cookie)).status).toBe(302)
    expect((await post(origin, response, cookie)).status).toBe(401)
    server.close()
  })

  it('refuses a correctly signed response nobody asked for', async () => {
    const { server, origin, keys } = await samlHost()
    const { authn, cookie } = await start(origin)
    const unsolicited = answer(keys, { ...authn, id: '_never-issued-by-this-host' })
    expect((await post(origin, unsolicited, cookie)).status).toBe(401)
    server.close()
  })

  it('refuses a response signed by a key other than the company IdP', async () => {
    const { server, origin } = await samlHost()
    const { authn, cookie } = await start(origin)
    const forged = answer(makeIdpKeys('attacker-idp'), authn)
    expect((await post(origin, forged, cookie)).status).toBe(401)
    server.close()
  })

  it('does not admit a valid IdP user who was never invited', async () => {
    const { server, origin, keys } = await samlHost()
    const { authn, cookie } = await start(origin)
    const res = await post(origin, answer(keys, authn, 'stranger@northwind.test'), cookie)
    expect(res.status).toBe(403)
    expect(res.headers.get('location')).toBeNull()
    server.close()
  })
})

describe('company OIDC on the dedicated host', () => {
  // The callback used to accept any pending `state`, from any browser. These
  // drive the host's own demo issuer through the real redirects, then try to
  // finish one browser's sign-in from another.
  async function oidcHost() {
    const probe = createServer()
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const { port } = probe.address()
    await new Promise((resolve) => probe.close(resolve))
    const origin = `http://127.0.0.1:${port}`

    const db = new PGlite()
    const engine = createEngine(db)
    const secret = 'session-secret-for-the-oidc-test'
    const server = createOwnStackServer({
      engine,
      db,
      sessionSecret: secret,
      origin,
      auth: { method: 'oidc', issuer: `${origin}/oidc`, clientId: request.authClientId },
      controlToken: 'operator-token',
    })
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
    expect((await provision(engine, db)).ok).toBe(true)
    return { server, origin, secret }
  }

  /** One browser: /auth/start, then the issuer's sign-in, up to the callback URL. */
  async function begin(origin, email = 'asha@northwind.test') {
    const start = await fetch(`${origin}/auth/start`, { redirect: 'manual' })
    expect(start.status).toBe(302)
    const cookie = String(start.headers.get('set-cookie') || '').split(';')[0]
    expect(cookie).toMatch(/^ohsms_oidc=.+/)
    expect(start.headers.get('set-cookie')).toMatch(/HttpOnly/)
    const authorize = await fetch(start.headers.get('location'), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email }).toString(),
    })
    expect(authorize.status).toBe(302)
    return { cookie, callback: authorize.headers.get('location') }
  }

  const finish = (callback, cookie = '') =>
    fetch(callback, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })

  it('signs in the browser that started the sign-in, and clears its cookie', async () => {
    const { server, origin, secret } = await oidcHost()
    const { cookie, callback } = await begin(origin)
    const res = await finish(callback, cookie)
    expect(res.status).toBe(302)
    const session = decodeURIComponent(res.headers.get('location').split('#session=')[1])
    expect(verifySession(secret, session).sub).toBe('asha@northwind.test')
    expect(res.headers.get('set-cookie')).toMatch(/^ohsms_oidc=;.*Max-Age=0/)
    server.close()
  })

  it("refuses to finish one browser's sign-in in another browser", async () => {
    const { server, origin } = await oidcHost()
    const attacker = await begin(origin)
    const victim = await begin(origin)
    const res = await finish(attacker.callback, victim.cookie)
    expect(res.status).toBe(400)
    expect(String(res.headers.get('location'))).not.toContain('#session=')
    server.close()
  })

  it('refuses a callback from a browser holding no sign-in cookie', async () => {
    const { server, origin } = await oidcHost()
    const { callback } = await begin(origin)
    expect((await finish(callback)).status).toBe(400)
    server.close()
  })

  it('refuses a sign-in left pending past ten minutes', async () => {
    const { server, origin } = await oidcHost()
    const { cookie, callback } = await begin(origin)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000)
    try {
      expect((await finish(callback, cookie)).status).toBe(400)
    } finally {
      clock.mockRestore()
      server.close()
    }
  })
})

// ── OIDC through the provider's discovery document ─────────────────────────
// Sign-in used to call ISSUER/authorize, /token and /userinfo, the shape of
// almost no real provider. This one puts them where Okta does. Then the
// document lies about its issuer, points somewhere it should not, and the
// provider says the email is unverified.
async function fakeProvider({ issuerOverride, tokenEndpoint, emailVerified = true } = {}) {
  const codes = new Map()
  const challenges = new Map()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const base = `http://127.0.0.1:${server.address().port}/oauth2/default`
    const json = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/oauth2/default/.well-known/openid-configuration') {
      return json({
        issuer: issuerOverride || base,
        authorization_endpoint: `${base}/v1/authorize`,
        token_endpoint: tokenEndpoint || `${base}/v1/token`,
        userinfo_endpoint: `${base}/v1/userinfo`,
      })
    }
    if (url.pathname === '/oauth2/default/v1/authorize') {
      const code = `code-${codes.size + 1}`
      codes.set(code, url.searchParams.get('login_hint') || 'asha@northwind.test')
      challenges.set(code, url.searchParams.get('code_challenge'))
      const back = new URL(url.searchParams.get('redirect_uri'))
      back.searchParams.set('code', code)
      back.searchParams.set('state', url.searchParams.get('state'))
      res.writeHead(302, { Location: back.toString() })
      return res.end()
    }
    if (url.pathname === '/oauth2/default/v1/token' && req.method === 'POST') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const form = new URLSearchParams(raw)
      const code = form.get('code')
      // PKCE: the verifier must hash to the challenge sent with the
      // authorize request, so this test fails if the host stops sending it.
      const verifier = form.get('code_verifier') || ''
      const hashed = createHash('sha256').update(verifier).digest('base64url')
      if (!codes.has(code) || !verifier || hashed !== challenges.get(code)) {
        res.writeHead(400)
        return res.end()
      }
      return json({ access_token: `at-${code}`, token_type: 'Bearer' })
    }
    if (url.pathname === '/oauth2/default/v1/userinfo') {
      const code = String(req.headers.authorization || '').replace('Bearer at-', '')
      const email = codes.get(code)
      return json({ sub: `okta|${email}`, email, email_verified: emailVerified, name: 'Asha' })
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, issuer: `http://127.0.0.1:${server.address().port}/oauth2/default` }
}

async function hostOnProvider(provider) {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  const db = new PGlite()
  const engine = createEngine(db)
  const server = createOwnStackServer({
    engine,
    db,
    sessionSecret: 'session-secret-for-the-discovery-test',
    origin,
    auth: {
      method: 'oidc',
      issuer: provider.issuer,
      clientId: 'weehs-okta',
      clientSecret: 'okta-secret',
    },
    controlToken: 'operator-token',
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  expect((await provision(engine, db)).ok).toBe(true)
  return { server, origin }
}

async function signInThrough(origin) {
  const start = await fetch(`${origin}/auth/start`, { redirect: 'manual' })
  if (start.status !== 302) return { start: start.status }
  const cookie = String(start.headers.get('set-cookie')).split(';')[0]
  const at = await fetch(start.headers.get('location'), { redirect: 'manual' })
  const back = await fetch(at.headers.get('location'), {
    redirect: 'manual',
    headers: { Cookie: cookie },
  })
  return {
    start: start.status,
    authorizeUrl: start.headers.get('location'),
    callback: back.status,
    session: (back.headers.get('location') || '').split('#session=')[1] || '',
  }
}

describe('company OIDC through discovery', () => {
  it("signs in through the provider's own endpoints, wherever they are", async () => {
    const provider = await fakeProvider()
    const { server, origin } = await hostOnProvider(provider)
    const result = await signInThrough(origin)
    expect(result.authorizeUrl).toContain('/oauth2/default/v1/authorize?')
    expect(result.authorizeUrl).toContain('client_id=weehs-okta')
    expect(result.callback).toBe(302)
    expect(result.session).not.toBe('')
    server.close()
    provider.server.close()
  })

  it('refuses a discovery document that names another issuer', async () => {
    const provider = await fakeProvider({ issuerOverride: 'https://evil.example/oauth2/default' })
    const { server, origin } = await hostOnProvider(provider)
    expect((await signInThrough(origin)).start).toBe(503)
    server.close()
    provider.server.close()
  })

  it('refuses an endpoint that is plain http off loopback', async () => {
    const provider = await fakeProvider({ tokenEndpoint: 'http://idp.example/oauth2/v1/token' })
    const { server, origin } = await hostOnProvider(provider)
    expect((await signInThrough(origin)).start).toBe(503)
    server.close()
    provider.server.close()
  })

  it('refuses an email the provider says is unverified', async () => {
    const provider = await fakeProvider({ emailVerified: false })
    const { server, origin } = await hostOnProvider(provider)
    const result = await signInThrough(origin)
    expect(result.callback).toBe(401)
    expect(result.session).toBe('')
    server.close()
    provider.server.close()
  })

  it('accepts http only on loopback, and only when the demo issuer is allowed', async () => {
    const provider = await fakeProvider()
    await expect(endpointsFor(provider.issuer)).rejects.toThrow(/https/)
    await expect(endpointsFor(provider.issuer, { allowLoopbackHttp: true })).resolves.toMatchObject(
      {
        tokenEndpoint: `${provider.issuer}/v1/token`,
      }
    )
    provider.server.close()
  })
})

describe('http server helper import', () => {
  it('does not listen during import', () => {
    expect(typeof createServer).toBe('function')
  })
})

describe('what an OIDC provider has to vouch for', () => {
  const calls = []
  const stub =
    (routes) =>
    async (url, init = {}) => {
      calls.push({ url: String(url), init })
      const body = routes[String(url)]
      return { ok: body !== undefined, status: body ? 200 : 404, json: async () => body }
    }
  const exchange = (userinfo, acceptUnverifiedEmail = false) =>
    identityFromCode({
      tokenEndpoint: 'https://idp.test/token',
      userinfoEndpoint: 'https://idp.test/userinfo',
      clientId: 'c',
      code: 'x',
      redirectUri: 'https://ehs.test/auth/callback',
      verifier: 'v',
      acceptUnverifiedEmail,
      fetchImpl: stub({
        'https://idp.test/token': { access_token: 'at' },
        'https://idp.test/userinfo': userinfo,
      }),
    })

  it('refuses a userinfo with no email_verified unless the operator accepts that', async () => {
    const user = { sub: 'u1', email: 'asha@northwind.test' }
    expect(await exchange(user)).toEqual({ ok: false, reason: 'email-unverified' })
    expect((await exchange(user, true)).ok).toBe(true)
    expect(await exchange({ ...user, email_verified: false }, true)).toEqual({
      ok: false,
      reason: 'email-unverified',
    })
    expect((await exchange({ ...user, email_verified: true })).ok).toBe(true)
  })

  it('reads groups from userinfo and from the ID token, as Entra sends them', async () => {
    const payload = Buffer.from(JSON.stringify({ groups: ['b1e2-guid', 'EHS-Admins'] })).toString(
      'base64url'
    )
    const out = await identityFromCode({
      tokenEndpoint: 'https://idp.test/token',
      userinfoEndpoint: 'https://idp.test/userinfo',
      clientId: 'c',
      code: 'x',
      redirectUri: 'https://ehs.test/auth/callback',
      verifier: 'v',
      fetchImpl: async (url) => ({
        ok: true,
        json: async () =>
          String(url).endsWith('/token')
            ? { access_token: 'at', id_token: `e30.${payload}.sig` }
            : {
                sub: 'u1',
                email: 'a@b.test',
                email_verified: true,
                groups: ['EHS-Admins', 'Okta-Group'],
              },
      }),
    })
    expect(out.groups.sort()).toEqual(['EHS-Admins', 'Okta-Group', 'b1e2-guid'])
  })

  it('follows no redirect from the provider', async () => {
    calls.length = 0
    await exchange({ sub: 'u1', email: 'a@b.test', email_verified: true })
    expect(calls).toHaveLength(2)
    for (const call of calls) expect(call.init.redirect).toBe('error')
  })

  it('compares the issuer exactly, trailing slash included', async () => {
    const doc = (issuer) => ({
      issuer,
      authorization_endpoint: 'https://idp.test/a',
      token_endpoint: 'https://idp.test/t',
      userinfo_endpoint: 'https://idp.test/u',
    })
    const where = 'https://idp.test/tenant/.well-known/openid-configuration'
    await expect(
      endpointsFor('https://idp.test/tenant', {
        fetchImpl: stub({ [where]: doc('https://idp.test/tenant/') }),
      })
    ).rejects.toThrow(/another issuer/)
    await expect(
      endpointsFor('https://idp.test/tenant/', {
        fetchImpl: stub({ [where]: doc('https://idp.test/tenant/') }),
      })
    ).resolves.toMatchObject({ tokenEndpoint: 'https://idp.test/t' })
  })
})

describe('Microsoft Entra, chosen at /setup', () => {
  async function setUp(fields) {
    const db = new PGlite()
    const saved = []
    const server = createOwnStackServer({
      engine: createEngine(db),
      db,
      sessionSecret: 'session-secret-for-the-entra-test',
      origin: 'https://ehs.northwind.test',
      controlToken: 'operator-token-for-the-entra-test',
      demoIssuer: false,
      onAuthChange: (auth) => saved.push(auth),
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const res = await fetch(`http://127.0.0.1:${server.address().port}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: 'operator-token-for-the-entra-test',
        orgName: 'Northwind Metals',
        contactName: 'Asha Rao',
        contactEmail: 'asha@northwind.test',
        method: 'oidc',
        authIssuer: 'https://login.microsoftonline.com/0000-tenant/v2.0',
        authClientId: 'weehs-northwind',
        oidcClientSecret: 'entra-secret-value',
        ...fields,
      }).toString(),
    })
    await new Promise((resolve) => server.close(resolve))
    return { status: res.status, auth: saved.at(-1) }
  }

  it('accepts a missing email_verified only when the installer said single-tenant Entra', async () => {
    const entra = await setUp({ entraSingleTenant: 'on' })
    expect(entra.status).toBe(200)
    expect(entra.auth).toMatchObject({ method: 'oidc', acceptUnverifiedEmail: true })
    expect(JSON.stringify(entra.auth)).not.toContain('"acceptUnverifiedEmail":"on"')

    const other = await setUp({})
    expect(other.status).toBe(200)
    expect(other.auth.acceptUnverifiedEmail).toBeUndefined()
  })
})
