// The organization's server, running inside the Cloudflare Worker.
//
// Same handler as the Docker server (stack/handler.mjs). What differs:
//   - The database is Cloudflare D1 (the DB binding): SQLite, with every
//     access rule enforced in stack/policy.mjs before any SQL runs.
//   - Uploaded files live in the FILES R2 bucket (worker/files.js).
//   - The organization and its first administrator are created on the
//     first request (bootstrapOrganization), from ORG_NAME, ADMIN_EMAIL and
//     ADMIN_PASSWORD. Nothing is created once an admin exists.
//   - The tables are created on the first request if missing (CREATE …
//     IF NOT EXISTS, safe to run from several isolates at once).
//   - Mail (password-reset links) goes through Resend (worker/mail.js) when
//     MAIL_FROM and RESEND_API_KEY are set; without them there is no reset
//     by email and an administrator resets passwords instead.
//
// Settings: PUBLIC_ORIGIN, ORG_NAME, MAIL_FROM, ADMIN_MUST_CHANGE (vars). Secrets:
// SESSION_SECRET, DATA_KEY_MASTER, ADMIN_EMAIL, ADMIN_PASSWORD,
// RESEND_API_KEY. docs/CLOUDFLARE.md.

import { createEngine } from '../stack/engine.mjs'
import { ensureSchema } from '../stack/schema.mjs'
import { createOwnStackHandler } from '../stack/handler.mjs'
import { runtimeConfigScript } from '../stack/runtimeConfig.mjs'
import { blobKeyFrom } from '../stack/blobSign.mjs'
import { bootstrapOrganization } from '../stack/passwords.mjs'
import { createR2FileStore } from './files.js'
import { nodeRequest, nodeResponse } from './bridge.js'
import { resendMailer } from './mail.js'

const initializations = new WeakMap()

function initialize(db, env) {
  if (!initializations.has(db)) {
    const ready = (async () => {
      await ensureSchema(db)
      await bootstrapOrganization(createEngine(db), db, {
        orgName: env.ORG_NAME || 'Cult Fit',
        adminEmail: env.ADMIN_EMAIL || '',
        adminPassword: env.ADMIN_PASSWORD || '',
        mustChange: env.ADMIN_MUST_CHANGE !== 'false',
      })
    })().catch((err) => {
      initializations.delete(db)
      throw err
    })
    initializations.set(db, ready)
  }
  return initializations.get(db)
}

export function settingsProblems(env) {
  const problems = []
  const origin = String(env.PUBLIC_ORIGIN || '').replace(/\/$/, '')
  if (!/^https:\/\/[^/]+$/.test(origin)) problems.push('PUBLIC_ORIGIN')
  if (String(env.SESSION_SECRET || '').length < 32) problems.push('SESSION_SECRET')
  if (Buffer.from(String(env.DATA_KEY_MASTER || ''), 'base64').length !== 32) {
    problems.push('DATA_KEY_MASTER')
  }
  if (!env.DB?.prepare) problems.push('DB (D1) binding')
  return problems
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

/** Answers one server request inside the Worker. */
export async function serveOnCloudflare(request, env, ctx) {
  const problems = settingsProblems(env)
  if (problems.length) {
    return json(503, {
      code: 'unavailable',
      message: `the server is not configured: ${problems.join(', ')}`,
    })
  }
  const origin = String(env.PUBLIC_ORIGIN).replace(/\/$/, '')
  const url = new URL(request.url)
  const mail = resendMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM })
  // index.html waits for this script before running the app. Its contents
  // depend only on settings, so loading it must never wait for D1 or bootstrap.
  if (url.pathname === '/runtime-config.js') {
    return new Response(runtimeConfigScript({ origin, resetByEmail: Boolean(mail) }), {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  }
  // Without the FILES bucket, /presign answers 503 and the app keeps files of
  // up to 700 KB inside the record instead (src/shared/storage putFile).
  const files = env.FILES
    ? createR2FileStore({ bucket: env.FILES, key: blobKeyFrom(env.SESSION_SECRET), origin })
    : null
  // File bytes never touch the database.
  if (url.pathname === '/blob') {
    return files
      ? files.handle(request)
      : json(404, { code: 'not-found', message: 'file storage is not configured' })
  }

  const db = env.DB
  try {
    await initialize(db, env)
    if (url.pathname === '/health') {
      await db.prepare('SELECT 1').first()
      return json(200, {
        ok: true,
        database: 'ok',
        files: Boolean(files),
        mail: Boolean(env.RESEND_API_KEY && env.MAIL_FROM),
        ...(env.BUILD_COMMIT ? { version: env.BUILD_COMMIT } : {}),
      })
    }
    const handle = createOwnStackHandler({
      engine: createEngine(db),
      db,
      sessionSecret: env.SESSION_SECRET,
      origin,
      dataKeyMaster: env.DATA_KEY_MASTER,
      mail,
      blobStore: files,
      // The response goes first; the mail is sent after it.
      background: (promise) => ctx?.waitUntil?.(promise),
    })
    const req = nodeRequest(request)
    const { res, done, toResponse } = nodeResponse()
    await handle(req, res)
    await done
    return toResponse()
  } catch (err) {
    console.error('server request failed', url.pathname, err?.code || '', err?.message || err)
    return json(500, { code: 'internal', message: 'request failed' })
  }
}
