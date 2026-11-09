// The organization's server. It is not a policy service: data calls set the
// session uid and run SQL, and RLS decides. Presign and the workers re-read
// the profile. The OIDC routes exist so a demo issuer can live on the same
// host for local development; a company issuer is the URL given at /setup.
// Company SAML has no demo IdP here: the host is only ever the service
// provider.

import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { verifySession, signSession } from './session.mjs'
import { decidePresign } from './presign.mjs'
import { authorizeUrl, endpointsFor, identityFromCode } from './oidc.mjs'
import { identityFromSupabase } from './supabaseAuth.mjs'
import { authnRequestId, samlClient, identityFromSaml } from './saml.mjs'
import { establishIdentity } from './identity.mjs'
import {
  createScimToken,
  getGroupRoles,
  handleScim,
  revokeScimToken,
  scimStatus,
  setGroupRoles,
} from './directory.mjs'
import { getAutoJoin, inviteMember, listInvites, revokeInvite, setAutoJoin } from './invites.mjs'
import {
  stampIdentity,
  completePasswordChange,
  releaseDataKeys,
  deleteOrgFile,
  runRetention,
  withdrawStaleMirrors,
  sweepLoto,
  productMail,
} from './workers.mjs'
import { renderSetupClosed, renderSetupDone, renderSetupForm } from './setupPage.mjs'
import { initializeOrganization, readOrganization } from './setup.mjs'

const WORKER = { role: 'ohsms_worker', uid: '' }

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

// Every route that reads a body is reachable before any session exists
// (/setup, /auth/saml, /auth/supabase), so an uncapped read lets
// anyone hold an arbitrary upload in this process's memory. The cap sits above
// the largest legitimate body: a /data commit carrying an inline file of up to
// MAX_INLINE_BYTES (700 KB) as base64, with room for the rest of the batch.
export const MAX_BODY_BYTES = 4 * 1024 * 1024

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const err = new Error('body too large')
      err.code = 'payload-too-large'
      throw err
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  const type = String(req.headers['content-type'] || '')
  if (type.includes('application/x-www-form-urlencoded')) {
    const out = {}
    for (const [key, value] of new URLSearchParams(raw)) out[key] = value
    return out
  }
  try {
    return JSON.parse(raw)
  } catch {
    return { __raw: raw }
  }
}

// What a refused sign-in says. A disabled account is told so, rather than
// being told it has none, which would send them asking for an invite.
function refusedSignIn(reason) {
  return reason === 'disabled'
    ? {
        code: 'permission-denied',
        reason,
        message: 'your account on this organization is disabled',
      }
    : {
        code: 'permission-denied',
        reason: 'no-account',
        message: 'no account on this organization',
      }
}

function sessionOf(req, secret) {
  const header = String(req.headers.authorization || '')
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  return verifySession(secret, token)
}

function challenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function createOwnStackServer({
  engine,
  db,
  sessionSecret,
  auth = { method: 'oidc', issuer: '', clientId: '', clientSecret: '' },
  origin = '',
  dataKeyMaster = '',
  mail = null,
  // Stored files (stack/blobs.mjs). null serves no uploads.
  blobStore = null,
  codes = new Map(),
  // The setup code /setup asks for: CONTROL_TOKEN.
  controlToken = '',
  // Called with the sign-in configuration whenever /setup connects one, so a
  // deployment can keep it across a restart (stack/state.mjs).
  onAuthChange = null,
  // The built-in OIDC issuer under /oidc signs in whoever types an address.
  // It exists so the local demo needs no IdP, and it is the issuer an
  // unconfigured host falls back to. A deployment turns it off
  // (stack/app.mjs does, always): with it on, anyone who typed an invited
  // founder's email would be signed in as them.
  demoIssuer = true,
  // Accept an OIDC sign-in whose userinfo has no email_verified claim
  // (stack/oidc.mjs explains when that is reasonable).
  oidcAcceptUnverifiedEmail = false,
}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/health') {
        send(res, 200, { ok: true })
        return
      }
      if (req.method === 'POST' && url.pathname === '/data') {
        await onData(req, res)
        return
      }
      if (req.method === 'GET' && url.pathname === '/auth/start') {
        await onAuthStart(url, res)
        return
      }
      if (req.method === 'POST' && url.pathname === '/auth/saml') {
        await onSaml(req, res)
        return
      }
      if (req.method === 'GET' && url.pathname === '/auth/callback') {
        await onCallback(req, url, res)
        return
      }
      if (req.method === 'POST' && url.pathname === '/auth/supabase') {
        await onSupabase(req, res)
        return
      }
      if (req.method === 'POST' && url.pathname === '/presign') {
        await onPresign(req, res)
        return
      }
      if (url.pathname === '/blob') {
        if (!blobStore) {
          send(res, 404, { code: 'not-found', message: 'file storage is not configured' })
          return
        }
        await blobStore.handle(req, res, url)
        return
      }
      if (req.method === 'POST' && url.pathname.startsWith('/rpc/')) {
        await onRpc(req, res, url.pathname.slice('/rpc/'.length))
        return
      }
      if (
        demoIssuer &&
        (url.pathname === '/oidc/.well-known/openid-configuration' ||
          url.pathname === '/.well-known/openid-configuration')
      ) {
        const base = `${origin || ''}/oidc`
        send(res, 200, {
          issuer: `${origin}/oidc`,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          userinfo_endpoint: `${base}/userinfo`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        })
        return
      }
      if (demoIssuer && url.pathname === '/oidc/authorize') {
        await onAuthorize(req, res, url)
        return
      }
      if (demoIssuer && req.method === 'POST' && url.pathname === '/oidc/token') {
        await onToken(req, res)
        return
      }
      if (demoIssuer && req.method === 'GET' && url.pathname === '/oidc/userinfo') {
        onUserinfo(req, res)
        return
      }
      // SCIM 2.0: the company's directory adding, changing and deactivating
      // people (directory.mjs). Its own bearer token; no session.
      if (url.pathname.startsWith('/scim/v2/')) {
        let body = {}
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
          body = await readBody(req)
          if (body.__raw !== undefined) {
            send(
              res,
              400,
              { status: '400', detail: 'The body must be JSON.' },
              {
                'Content-Type': 'application/scim+json',
              }
            )
            return
          }
        }
        const out = await handleScim({
          engine,
          db,
          origin,
          method: req.method,
          pathname: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body,
        })
        if (out.status === 204) {
          res.writeHead(204, { 'Cache-Control': 'no-store' })
          res.end()
          return
        }
        res.writeHead(out.status, {
          'Content-Type': 'application/scim+json',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify(out.json))
        return
      }
      if (req.method === 'GET' && url.pathname === '/setup') {
        await onSetupGet(res)
        return
      }
      if (req.method === 'POST' && url.pathname === '/setup') {
        await onSetupPost(req, res)
        return
      }
      send(res, 404, { code: 'not-found', message: 'not found' })
    } catch (err) {
      if (err.code === 'payload-too-large') {
        send(res, 413, { code: err.code, message: 'request too large' }, { Connection: 'close' })
        return
      }
      send(res, 500, { code: err.code || 'internal', message: 'request failed' })
    }
  })

  async function onData(req, res) {
    const body = await readBody(req)
    const session = sessionOf(req, sessionSecret)
    const roleSession = { role: 'ohsms_browser', uid: session?.sub || '' }
    if (body.op === 'get') {
      const doc = await engine.get(roleSession, body.path, body.id, { rev: Boolean(body.rev) })
      send(res, 200, { doc })
      return
    }
    if (body.op === 'list') {
      const rows = await engine.list(roleSession, body.path, body.opts || {})
      send(res, 200, { rows })
      return
    }
    if (body.op === 'count') {
      const count = await engine.count(roleSession, body.path, body.opts || {})
      send(res, 200, { count })
      return
    }
    if (body.op === 'commit') {
      try {
        const result = await engine.commit(roleSession, body.ops || [], body.expect || [])
        send(res, 200, result)
      } catch (err) {
        send(res, err.code === 'permission-denied' ? 403 : 400, {
          code: err.code || 'unknown',
          message: err.message,
        })
      }
      return
    }
    send(res, 400, { code: 'invalid-argument', message: 'unknown op' })
  }

  // One client for the life of the configuration. The AuthnRequest ids it
  // issues are held in its own cache, and /auth/saml accepts a response only
  // for one of those ids, so a fresh client per request would refuse every
  // sign-in.
  let saml = null
  function samlFor() {
    if (!saml) {
      saml = samlClient({
        issuer: auth.clientId || 'ohsms',
        callbackUrl: `${origin}/auth/saml`,
        idpCert: auth.idpCert,
        entryPoint: auth.entryPoint,
      })
    }
    return saml
  }

  // The AuthnRequest ids above are host-wide, so on their own they prove a
  // response answers *some* sign-in this host started, not that it answers
  // the one this browser started. Without that, an invited user could start a
  // sign-in, authenticate as themselves, and have a victim's browser post the
  // response — the victim then works signed in as the attacker (login CSRF).
  // So /auth/start sets a one-time cookie naming its request, and /auth/saml
  // accepts only the response to that request. SameSite=None because the ACS
  // POST arrives cross-site from the IdP; Secure is required for that, and
  // browsers treat localhost as secure for the local demo.
  const SAML_COOKIE = 'ohsms_saml'
  const SAML_TTL_MS = 10 * 60 * 1000
  const samlCookie = (value, maxAge) =>
    `${SAML_COOKIE}=${value}; Path=/auth/saml; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`

  // `state` proves the callback answers a sign-in this host started, not that
  // it answers the one this browser started: the pending states are host-wide.
  // Without a tie to the browser, an invited user could start a sign-in,
  // authenticate as themselves, and send someone else's browser to the
  // callback URL — that person would then be working signed in as them (login
  // CSRF). So /auth/start sets a one-time cookie, and /auth/callback accepts
  // only the state that cookie was issued with. Lax is enough: the IdP comes
  // back with a top-level GET, which Lax cookies ride on.
  const OIDC_COOKIE = 'ohsms_oidc'
  const OIDC_TTL_MS = 10 * 60 * 1000
  const oidcCookie = (value, maxAge) =>
    `${OIDC_COOKIE}=${value}; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
    (String(origin).startsWith('https://') ? '; Secure' : '')

  function cookieOf(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [k, ...v] = part.trim().split('=')
      if (k === name) return v.join('=')
    }
    return ''
  }

  function sameSecret(a, b) {
    const x = Buffer.from(String(a))
    const y = Buffer.from(String(b))
    return x.length > 0 && x.length === y.length && timingSafeEqual(x, y)
  }

  function oidcIssuer() {
    return auth.issuer || (demoIssuer ? `${origin}/oidc` : '')
  }

  // Discovery is read once an hour per issuer, not per sign-in. A failure is
  // remembered for a short while, and concurrent starts share one request:
  // /auth/start is public, and without both each hit on a provider that is
  // down opened its own outbound fetch.
  const DISCOVERY_TTL_MS = 60 * 60 * 1000
  const DISCOVERY_RETRY_MS = 30 * 1000
  const discovered = new Map()
  const inFlight = new Map()
  async function oidcEndpoints() {
    const issuer = oidcIssuer()
    if (!issuer) return null
    const hit = discovered.get(issuer)
    if (hit && Date.now() - hit.at < (hit.endpoints ? DISCOVERY_TTL_MS : DISCOVERY_RETRY_MS)) {
      return hit.endpoints
    }
    if (!inFlight.has(issuer)) {
      const pending = endpointsFor(issuer, { allowLoopbackHttp: demoIssuer })
        .catch(() => null)
        .then((endpoints) => {
          discovered.set(issuer, { at: Date.now(), endpoints })
          inFlight.delete(issuer)
          return endpoints
        })
      inFlight.set(issuer, pending)
    }
    return inFlight.get(issuer)
  }

  async function onAuthStart(url, res) {
    if (auth.method === 'saml') {
      let location
      try {
        location = await samlFor().getAuthorizeUrlAsync('', {})
      } catch {
        send(res, 503, { code: 'unavailable', message: 'single sign-on is not configured' })
        return
      }
      const id = authnRequestId(location)
      if (!id) {
        send(res, 503, { code: 'unavailable', message: 'single sign-on is not configured' })
        return
      }
      const binding = randomBytes(24).toString('base64url')
      codes.set(`saml:${binding}`, { id, at: Date.now() })
      send(res, 302, '', {
        Location: location,
        'Set-Cookie': samlCookie(binding, SAML_TTL_MS / 1000),
      })
      return
    }
    const endpoints = await oidcEndpoints()
    if (!endpoints) {
      send(res, 503, { code: 'unavailable', message: 'single sign-on is not configured' })
      return
    }
    const state = randomBytes(16).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const binding = randomBytes(24).toString('base64url')
    codes.set(`state:${state}`, { verifier, binding, at: Date.now() })
    const location = authorizeUrl({
      authorizationEndpoint: endpoints.authorizationEndpoint,
      clientId: auth.clientId || 'ohsms',
      redirectUri: `${origin}/auth/callback`,
      state,
      challenge: challenge(verifier),
    })
    send(res, 302, '', {
      Location: location,
      'Set-Cookie': oidcCookie(binding, OIDC_TTL_MS / 1000),
    })
  }

  async function onCallback(req, url, res) {
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    const pending = codes.get(`state:${state}`)
    codes.delete(`state:${state}`)
    const clear = { 'Set-Cookie': oidcCookie('', 0) }
    if (
      !pending ||
      !code ||
      Date.now() - pending.at > OIDC_TTL_MS ||
      !sameSecret(cookieOf(req, OIDC_COOKIE), pending.binding)
    ) {
      send(res, 400, { code: 'invalid-argument', message: 'sign-in could not be completed' }, clear)
      return
    }
    const endpoints = await oidcEndpoints()
    if (!endpoints) {
      send(res, 503, { code: 'unavailable', message: 'single sign-on is not configured' }, clear)
      return
    }
    const identity = await identityFromCode({
      tokenEndpoint: endpoints.tokenEndpoint,
      userinfoEndpoint: endpoints.userinfoEndpoint,
      clientId: auth.clientId || 'ohsms',
      clientSecret: auth.clientSecret || '',
      code,
      redirectUri: `${origin}/auth/callback`,
      verifier: pending.verifier,
      // The deployment's setting, or the one chosen at /setup for an Entra
      // tenant (onSetupPost).
      acceptUnverifiedEmail: oidcAcceptUnverifiedEmail || auth.acceptUnverifiedEmail === true,
    })
    if (!identity.ok) {
      send(
        res,
        401,
        { code: 'unauthenticated', message: 'the identity provider refused the sign-in' },
        clear
      )
      return
    }
    const established = await establishIdentity(engine, db, identity)
    if (!established.ok) {
      send(res, 403, refusedSignIn(established.reason), clear)
      return
    }
    const token = signSession(sessionSecret, { sub: established.uid })
    const app = origin || '/'
    send(res, 302, '', { Location: `${app}/#session=${encodeURIComponent(token)}`, ...clear })
  }

  async function onSaml(req, res) {
    if (auth.method !== 'saml') {
      send(res, 404, { code: 'not-found', message: 'not found' })
      return
    }
    const body = await readBody(req)
    const binding = cookieOf(req, SAML_COOKIE)
    const pending = binding ? codes.get(`saml:${binding}`) : null
    if (binding) codes.delete(`saml:${binding}`)
    const clear = { 'Set-Cookie': samlCookie('', 0) }
    if (!pending || Date.now() - pending.at > SAML_TTL_MS) {
      send(res, 401, { code: 'unauthenticated', message: 'start sign-in again' }, clear)
      return
    }
    const identity = await identityFromSaml(samlFor(), String(body.SAMLResponse || ''))
    if (identity.ok && identity.inResponseTo !== pending.id) {
      send(res, 401, { code: 'unauthenticated', message: 'start sign-in again' }, clear)
      return
    }
    if (!identity.ok) {
      send(
        res,
        401,
        { code: 'unauthenticated', message: 'the identity provider refused the sign-in' },
        clear
      )
      return
    }
    const established = await establishIdentity(engine, db, identity)
    if (!established.ok) {
      send(res, 403, refusedSignIn(established.reason), clear)
      return
    }
    const token = signSession(sessionSecret, { sub: established.uid })
    const app = origin || '/'
    send(res, 302, '', { Location: `${app}/#session=${encodeURIComponent(token)}`, ...clear })
  }

  async function onSupabase(req, res) {
    const body = await readBody(req)
    const identity = await identityFromSupabase({
      issuer: auth.issuer,
      anonKey: auth.anonKey,
      email: body.email,
      password: body.password,
    })
    if (!identity.ok) {
      send(res, 401, { code: 'unauthenticated', message: 'sign-in was refused' })
      return
    }
    const established = await establishIdentity(engine, db, identity)
    if (!established.ok) {
      send(res, 403, refusedSignIn(established.reason))
      return
    }
    send(res, 200, { token: signSession(sessionSecret, { sub: established.uid }) })
  }

  async function onPresign(req, res) {
    const body = await readBody(req)
    const session = sessionOf(req, sessionSecret)
    if (!session) {
      send(res, 401, { code: 'unauthenticated', message: 'sign in first' })
      return
    }
    const profile = await engine.get(WORKER, 'users', session.sub)
    const decision = decidePresign({ op: body.op, path: body.path, profile })
    if (!decision.ok) {
      send(res, 403, { code: 'permission-denied', message: 'refused' })
      return
    }
    if (!blobStore) {
      send(res, 503, { code: 'unavailable', message: 'file storage is not configured' })
      return
    }
    if (body.op === 'delete') {
      await blobStore.remove(body.path)
      send(res, 200, { ok: true })
      return
    }
    send(res, 200, {
      uploadUrl: blobStore.uploadUrl(body.path),
      publicUrl: blobStore.downloadUrl(body.path),
    })
  }

  async function onRpc(req, res, name) {
    const body = await readBody(req)
    const session = sessionOf(req, sessionSecret)
    const uid = session?.sub || ''
    const idp = auth.method === 'oidc' || auth.method === 'saml'
    const table = {
      stampIdentity: () => stampIdentity(engine, uid),
      backfillClaims: () => stampIdentity(engine, uid),
      completePasswordChange: () =>
        completePasswordChange(engine, db, {
          uid,
          authTime: session?.authTime,
          current: body.current,
          password: body.password,
          idp,
        }),
      getDataKeys: () => releaseDataKeys(engine, { uid, master: dataKeyMaster }),
      deleteOrgFile: () => deleteOrgFile(engine, blobStore, { uid, path: body.path }),
      purgeSoftDeleted: () => runRetention(engine, { uid }),
      withdrawStalePermitMirrors: () => withdrawStaleMirrors(engine),
      sweepLotoPermits: () => sweepLoto(engine, { uid }),
      notifyIncidentReported: () => productMail(mail, body),
      inviteMember: () =>
        inviteMember(engine, db, {
          uid,
          email: body.email,
          role: body.role,
          name: body.name,
          mail,
          origin,
        }),
      listInvites: () => listInvites(engine, db, { uid }),
      revokeInvite: () => revokeInvite(engine, db, { uid, email: body.email }),
      getAutoJoin: () => getAutoJoin(engine, db, { uid }),
      setAutoJoin: () => setAutoJoin(engine, db, { uid, domains: body.domains, role: body.role }),
      getGroupRoles: () => getGroupRoles(engine, db, { uid }),
      setGroupRoles: () => setGroupRoles(engine, db, { uid, rules: body.rules }),
      scimStatus: () => scimStatus(engine, db, { uid }),
      createScimToken: () => createScimToken(engine, db, { uid }),
      revokeScimToken: () => revokeScimToken(engine, db, { uid }),
    }
    const fn = table[name]
    if (!fn) {
      send(res, 404, { code: 'not-found', message: 'no such job' })
      return
    }
    const result = await fn()
    send(res, result?.ok === false ? 403 : 200, result)
  }

  async function onAuthorize(req, res, url) {
    if (req.method === 'GET') {
      const q = url.search
      send(
        res,
        200,
        `<!doctype html><html><body><form method="post" action="/oidc/authorize${q}"><label>Work email <input name="email" type="email" autocomplete="username" required></label><button type="submit">Continue</button></form></body></html>`
      )
      return
    }
    const raw = await readBody(req)
    const email = String(raw.email || raw.__raw?.match(/email=([^&]+)/)?.[1] || '').trim()
    const state = url.searchParams.get('state')
    const codeChallenge = url.searchParams.get('code_challenge')
    const redirect = url.searchParams.get('redirect_uri')
    if (!email || !state || !codeChallenge || !redirect) {
      send(res, 400, { code: 'invalid-argument', message: 'incomplete authorization request' })
      return
    }
    const code = randomBytes(24).toString('base64url')
    codes.set(`code:${code}`, { email, challenge: codeChallenge, at: Date.now() })
    const back = new URL(redirect)
    back.searchParams.set('code', code)
    back.searchParams.set('state', state)
    send(res, 302, '', { Location: back.toString() })
  }

  async function onToken(req, res) {
    const body = await readBody(req)
    const params = new URLSearchParams(body.__raw || '')
    const code = params.get('code') || body.code
    const verifier = params.get('code_verifier') || body.code_verifier
    const pending = codes.get(`code:${code}`)
    codes.delete(`code:${code}`)
    if (!pending || !verifier || challenge(verifier) !== pending.challenge) {
      send(res, 400, { error: 'invalid_grant' })
      return
    }
    const access = randomBytes(24).toString('base64url')
    codes.set(`access:${access}`, { email: pending.email, sub: pending.email })
    send(res, 200, { access_token: access, token_type: 'Bearer' })
  }

  function onUserinfo(req, res) {
    const header = String(req.headers.authorization || '')
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const user = codes.get(`access:${token}`)
    if (!user) {
      send(res, 401, { code: 'unauthenticated', message: 'unknown token' })
      return
    }
    send(res, 200, { sub: user.sub, email: user.email, email_verified: true, name: user.email })
  }

  // ── First-run setup in the browser (setupPage.mjs) ─────────────────────────
  // One organization per server: once it exists, /setup is closed for good,
  // whoever knows the code.
  const isLive = async () => Boolean(await readOrganization(engine))
  // CONTROL_TOKEN is 32 random bytes, so guessing it is not the risk; a cap on
  // wrong codes still stops this page from being a free oracle.
  const SETUP_FAILURES_MAX = 10
  const SETUP_WINDOW_MS = 15 * 60 * 1000
  let setupFailures = []
  let setupBusy = false

  async function onSetupGet(res) {
    send(res, 200, (await isLive()) ? renderSetupClosed({ origin }) : renderSetupForm({ origin }))
  }

  function setupValues(body) {
    const text = (v, max) =>
      typeof v === 'string'
        ? v
            .replace(/[\r\n\t]+/g, ' ')
            .trim()
            .slice(0, max)
        : ''
    return {
      orgName: text(body.orgName, 120),
      address: text(body.address, 200),
      contactName: text(body.contactName, 120),
      contactEmail: text(body.contactEmail, 254).toLowerCase(),
      method: body.method === 'oidc' ? 'oidc' : body.method === 'saml' ? 'saml' : '',
      samlEntryPoint: text(body.samlEntryPoint, 2048),
      authIssuer: text(body.authIssuer, 2048),
      authClientId: text(body.authClientId, 256),
      entraSingleTenant: body.entraSingleTenant === 'on',
    }
  }

  const httpsUrl = (v) => {
    try {
      const u = new URL(v)
      return u.protocol === 'https:' && !u.username && !u.password
    } catch {
      return false
    }
  }

  async function onSetupPost(req, res) {
    const refuse = (status, reason, values) =>
      send(res, status, renderSetupForm({ origin, values, reason }))
    if (await isLive()) {
      send(res, 409, renderSetupClosed({ origin }))
      return
    }
    const now = Date.now()
    setupFailures = setupFailures.filter((t) => now - t < SETUP_WINDOW_MS)
    let body
    try {
      body = await readBody(req)
    } catch {
      refuse(400, 'shape', {})
      return
    }
    const values = setupValues(body)
    if (setupFailures.length >= SETUP_FAILURES_MAX) {
      refuse(429, 'too-many', values)
      return
    }
    if (!controlToken || !sameSecret(String(body.code || '').trim(), controlToken)) {
      setupFailures.push(now)
      refuse(403, 'code', values)
      return
    }
    for (const key of ['orgName', 'contactName']) {
      if (!values[key]) return refuse(400, key, values)
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contactEmail)) {
      return refuse(400, 'contactEmail', values)
    }
    let nextAuth
    if (values.method === 'saml') {
      const cert = typeof body.samlIdpCert === 'string' ? body.samlIdpCert.trim() : ''
      if (!values.samlEntryPoint || !cert) return refuse(400, 'saml', values)
      if (!httpsUrl(values.samlEntryPoint)) return refuse(400, 'samlUrl', values)
      // The SP entity id the setup page tells the IdP to expect is this origin.
      nextAuth = { method: 'saml', clientId: origin, idpCert: cert, entryPoint: values.samlEntryPoint }
    } else if (values.method === 'oidc') {
      const secret = typeof body.oidcClientSecret === 'string' ? body.oidcClientSecret.trim() : ''
      if (!values.authIssuer || !values.authClientId || !secret) {
        return refuse(400, 'oidc', values)
      }
      if (!httpsUrl(values.authIssuer)) return refuse(400, 'oidcIssuer', values)
      nextAuth = {
        method: 'oidc',
        issuer: values.authIssuer,
        clientId: values.authClientId,
        clientSecret: secret,
        // Microsoft Entra sends no email_verified claim. Its single-tenant
        // registration's email is set by the tenant's own admins, and the
        // installer said so on the form.
        ...(values.entraSingleTenant ? { acceptUnverifiedEmail: true } : {}),
      }
    } else {
      return refuse(400, 'method', values)
    }
    // Two submissions at once must not create two organizations.
    if (setupBusy) return refuse(409, 'already-live', values)
    setupBusy = true
    try {
      const created = await initializeOrganization({
        engine,
        db,
        orgName: values.orgName,
        address: values.address,
        adminEmail: values.contactEmail,
        adminName: values.contactName,
      })
      if (!created.ok) {
        if (created.reason === 'already-live') {
          send(res, 409, renderSetupClosed({ origin }))
          return
        }
        return refuse(400, created.reason === 'adminEmail' ? 'contactEmail' : 'fulfill', values)
      }
      auth = { ...nextAuth }
      saml = null
      await onAuthChange?.(auth)
      send(
        res,
        200,
        renderSetupDone({ origin, orgName: values.orgName, email: values.contactEmail })
      )
    } finally {
      setupBusy = false
    }
  }

  return server
}
