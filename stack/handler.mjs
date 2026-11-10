// The organization's server. It is not a policy service: data calls set the
// session uid and run SQL, and RLS decides. Presign and the server jobs
// re-read the caller's live profile.
//
// Sign-in is email and password, kept by this server (stack/passwords.mjs).
// The organization and its first administrator are created on first start
// (bootstrapOrganization); there is no setup page and no external identity
// provider.

import { verifySession, signSession } from './session.mjs'
import { decidePresign } from './presign.mjs'
import {
  releaseDataKeys,
  deleteOrgFile,
  runRetention,
  withdrawStaleMirrors,
  sweepLoto,
  isLiveAdmin,
  stampIdentity,
} from './workers.mjs'
import {
  changeOwnPassword,
  completePasswordReset,
  createMember,
  requestPasswordReset,
  resetMemberPassword,
  signInWithPassword,
} from './passwords.mjs'

const WORKER = { role: 'ohsms_worker', uid: '' }
const ADMIN_JOBS = new Set(['purgeSoftDeleted', 'withdrawStalePermitMirrors', 'sweepLotoPermits'])

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
// (/auth/password), so an uncapped read lets anyone hold an arbitrary upload
// in this process's memory. The cap sits above the largest legitimate body: a
// /data commit carrying an inline file of up to MAX_INLINE_BYTES (700 KB) as
// base64, with room for the rest of the batch.
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
  try {
    return JSON.parse(raw)
  } catch {
    return { __raw: raw }
  }
}

function sessionOf(req, secret) {
  const header = String(req.headers.authorization || '')
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  return verifySession(secret, token)
}

export function createOwnStackHandler({
  engine,
  db,
  sessionSecret,
  // The public address; password-reset links are built on it.
  origin = '',
  dataKeyMaster = '',
  // ({ to, subject, text }) => { sent }. null: no mail, so no reset by email.
  mail = null,
  // Stored files (stack/blobs.mjs, worker/files.js). null serves no uploads.
  blobStore = null,
  // Runs work after the response has gone (ctx.waitUntil on Cloudflare), so
  // a reset request answers in the same time whether or not a mail is sent.
  background = (promise) => {
    promise.catch(() => {})
  },
}) {
  async function handle(req, res) {
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
      if (req.method === 'POST' && url.pathname === '/auth/password') {
        await onPassword(req, res)
        return
      }
      if (req.method === 'POST' && url.pathname === '/auth/forgot') {
        await onForgot(req, res)
        return
      }
      if (req.method === 'POST' && url.pathname === '/auth/reset') {
        await onReset(req, res)
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
      send(res, 404, { code: 'not-found', message: 'not found' })
    } catch (err) {
      if (err.code === 'payload-too-large') {
        send(res, 413, { code: err.code, message: 'request too large' }, { Connection: 'close' })
        return
      }
      send(res, 500, { code: err.code || 'internal', message: 'request failed' })
    }
  }

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

  async function onPassword(req, res) {
    const body = await readBody(req)
    const result = await signInWithPassword(engine, db, {
      email: body.email,
      password: body.password,
    })
    if (!result.ok) {
      const message =
        result.reason === 'locked'
          ? 'Too many wrong passwords. Try again in 15 minutes, or ask an administrator.'
          : result.reason === 'disabled'
            ? 'This account is disabled. Ask an administrator.'
            : 'That email and password do not match.'
      send(res, result.reason === 'locked' ? 429 : 401, {
        code: 'unauthenticated',
        reason: result.reason,
        message,
      })
      return
    }
    send(res, 200, { token: signSession(sessionSecret, { sub: result.uid }) })
  }

  async function onForgot(req, res) {
    const body = await readBody(req)
    if (!mail || !origin) {
      send(res, 503, { code: 'unavailable', message: 'Password reset by email is not set up. Ask an administrator.' })
      return
    }
    background(
      requestPasswordReset(engine, db, { email: body.email, origin, send: mail }).catch((err) =>
        console.error('password reset mail failed', err?.message || err)
      )
    )
    // The same answer whether or not the address has an account.
    send(res, 200, {
      ok: true,
      message: 'If that address has an account, a reset link is on its way. It works for 30 minutes.',
    })
  }

  async function onReset(req, res) {
    const body = await readBody(req)
    const result = await completePasswordReset(engine, db, {
      token: body.token,
      password: body.password,
    })
    if (!result.ok) {
      send(res, 400, {
        code: 'invalid-argument',
        reason: result.reason,
        message:
          result.reason === 'policy'
            ? 'Choose a password of at least 10 characters.'
            : 'This reset link has expired or was already used. Ask for a new one.',
      })
      return
    }
    send(res, 200, { ok: true })
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
    const table = {
      stampIdentity: () => stampIdentity(engine, uid),
      completePasswordChange: () =>
        changeOwnPassword(engine, db, {
          uid,
          authTime: session?.authTime,
          current: body.current,
          password: body.password,
        }),
      createMember: () =>
        createMember(engine, db, {
          uid,
          email: body.email,
          name: body.name,
          role: body.role,
          password: body.password,
        }),
      resetMemberPassword: () =>
        resetMemberPassword(engine, db, { uid, targetUid: body.uid, password: body.password }),
      getDataKeys: () => releaseDataKeys(engine, { uid, master: dataKeyMaster }),
      deleteOrgFile: () => deleteOrgFile(engine, blobStore, { uid, path: body.path }),
      purgeSoftDeleted: () => runRetention(engine, { uid }),
      withdrawStalePermitMirrors: () => withdrawStaleMirrors(engine),
      sweepLotoPermits: () => sweepLoto(engine, { uid }),
    }
    const fn = table[name]
    if (!fn) {
      send(res, 404, { code: 'not-found', message: 'no such job' })
      return
    }
    if (!uid) {
      send(res, 401, { code: 'unauthenticated', message: 'sign in first' })
      return
    }
    // Jobs that touch every record are an administrator's to run.
    if (ADMIN_JOBS.has(name) && !(await isLiveAdmin(engine, uid))) {
      send(res, 403, { ok: false, code: 'permission-denied', reason: 'not-admin' })
      return
    }
    const result = await fn()
    send(res, result?.ok === false ? 403 : 200, result)
  }

  return handle
}
