// The organization's server, running inside the Cloudflare Worker.
//
// Same handler as the Docker server (stack/handler.mjs). What differs:
//   - Postgres is reached through the HYPERDRIVE binding, one pool per request.
//   - Uploaded files live in the FILES R2 bucket (worker/files.js).
//   - The organization and its first administrator are created on the
//     first request (bootstrapOrganization), from ORG_NAME, ADMIN_EMAIL and
//     ADMIN_PASSWORD. Nothing is created once an admin exists.
//   - The schema is applied once per database version, under an advisory
//     lock, by whichever request gets there first.
//   - No mail.
//
// Settings: PUBLIC_ORIGIN, ORG_NAME (vars). Secrets: SESSION_SECRET,
// DATA_KEY_MASTER, ADMIN_EMAIL, ADMIN_PASSWORD. docs/CLOUDFLARE.md.

import SCHEMA from '../stack/schema.sql'
import { createPgDatabase } from '../stack/pg.mjs'
import { applySchema, createEngine } from '../stack/engine.mjs'
import { createOwnStackHandler } from '../stack/handler.mjs'
import { bootstrapOrganization } from '../stack/passwords.mjs'
import { runtimeConfigScript } from '../stack/runtimeConfig.mjs'
import { blobKeyFrom } from '../stack/blobSign.mjs'
import { createR2FileStore } from './files.js'
import { nodeRequest, nodeResponse } from './bridge.js'

// Bumps whenever schema.sql changes, so a new deploy applies it once.
function fingerprint(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}
export const SCHEMA_VERSION = `schema:${fingerprint(SCHEMA)}`

let schemaReady = false
let bootstrapped = null

export async function ensureSchema(db) {
  if (schemaReady) return
  const applied = await db
    .query('SELECT 1 FROM schema_migrations WHERE id = $1', [SCHEMA_VERSION])
    .then((r) => r.rows.length > 0)
    .catch(() => false)
  if (!applied) {
    await db.transaction(async (tx) => {
      // One applier at a time across every isolate; the others wait, then
      // find the version recorded and skip.
      await tx.query('SELECT pg_advisory_xact_lock(7243100)')
      const again = await tx
        .query(
          "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS t"
        )
        .then((r) => r.rows[0]?.t)
      const done =
        again &&
        (await tx.query('SELECT 1 FROM schema_migrations WHERE id = $1', [SCHEMA_VERSION])).rows
          .length > 0
      if (done) return
      await applySchema(tx, SCHEMA)
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING', [
        SCHEMA_VERSION,
      ])
    })
  }
  schemaReady = true
}

export function settingsProblems(env) {
  const problems = []
  const origin = String(env.PUBLIC_ORIGIN || '').replace(/\/$/, '')
  if (!/^https:\/\/[^/]+$/.test(origin)) problems.push('PUBLIC_ORIGIN')
  if (String(env.SESSION_SECRET || '').length < 32) problems.push('SESSION_SECRET')
  if (Buffer.from(String(env.DATA_KEY_MASTER || ''), 'base64').length !== 32) {
    problems.push('DATA_KEY_MASTER')
  }
  if (!env.HYPERDRIVE?.connectionString) problems.push('HYPERDRIVE binding')
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
  // Without the FILES bucket, /presign answers 503 and the app keeps files of
  // up to 700 KB inside the record instead (src/shared/storage putFile).
  const files = env.FILES
    ? createR2FileStore({ bucket: env.FILES, key: blobKeyFrom(env.SESSION_SECRET), origin })
    : null
  const url = new URL(request.url)
  // File bytes never touch Postgres.
  if (url.pathname === '/blob') {
    return files ? files.handle(request) : json(404, { code: 'not-found', message: 'file storage is not configured' })
  }

  const db = createPgDatabase(env.HYPERDRIVE.connectionString, { max: 3 })
  try {
    await ensureSchema(db)
    // Once per isolate: the organization and its first admin, if missing.
    bootstrapped ||= await bootstrapOrganization(createEngine(db), db, {
      orgName: env.ORG_NAME || 'Cult Fit',
      adminEmail: env.ADMIN_EMAIL || '',
      adminPassword: env.ADMIN_PASSWORD || '',
    })
    if (url.pathname === '/health') {
      await db.query('SELECT 1')
      return json(200, { ok: true, database: 'ok', files: Boolean(files), schema: SCHEMA_VERSION })
    }
    if (url.pathname === '/runtime-config.js') {
      return new Response(runtimeConfigScript({ origin }), {
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })
    }
    const handle = createOwnStackHandler({
      engine: createEngine(db),
      db,
      sessionSecret: env.SESSION_SECRET,
      dataKeyMaster: env.DATA_KEY_MASTER,
      mail: null,
      blobStore: files,
    })
    const req = nodeRequest(request)
    const { res, done, toResponse } = nodeResponse()
    await handle(req, res)
    await done
    return toResponse()
  } catch (err) {
    console.error('server request failed', url.pathname, err?.code || '', err?.message || err)
    // The one failure an installer can fix without reading logs: the app's
    // database user was not given the two roles (stack/planetscale-setup.sql).
    if (!schemaReady && err?.code === '42501') {
      // What the app actually sees, so a setup run against another database,
      // branch or user is obvious. No secrets: names only.
      const seen = await db
        .query(
          `SELECT current_user AS "user", current_database() AS database,
                  ARRAY(SELECT rolname FROM pg_roles WHERE rolname LIKE 'ohsms%' ORDER BY 1) AS roles,
                  ARRAY(SELECT b.rolname FROM pg_auth_members m
                          JOIN pg_roles b ON b.oid = m.roleid
                          JOIN pg_roles u ON u.oid = m.member
                         WHERE u.rolname = current_user AND b.rolname LIKE 'ohsms%' ORDER BY 1) AS granted`
        )
        .then((r) => r.rows[0])
        .catch(() => null)
      return json(503, {
        code: 'database-setup-needed',
        message: `${err.message}. Run stack/planetscale-setup.sql once as the database administrator.`,
        seen,
      })
    }
    return json(500, { code: 'internal', message: 'request failed' })
  } finally {
    ctx?.waitUntil?.(db.end().catch(() => {}))
  }
}
