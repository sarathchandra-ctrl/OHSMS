// The organization's server as a Node process: the gateway the app talks to
// (/data, /rpc, /presign, /blob, password sign-in) and the built app itself,
// on one origin. Production runs the same handler inside the Cloudflare
// Worker (worker/server.js); this is for local development
// (scripts/dev-local.mjs) and the tests, which run it on an in-memory SQLite.
//
// On start it creates the organization and its first administrator if the
// database has none (bootstrapOrganization).

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { applySchema, createEngine } from './engine.mjs'
import { createOwnStackServer } from './server.mjs'
import { bootstrapOrganization } from './passwords.mjs'
import { blobKeyFrom, createBlobStore } from './blobs.mjs'
import { API_PREFIXES, runtimeConfigScript } from './runtimeConfig.mjs'

export { API_PREFIXES, runtimeConfigScript }

// Paths the host answers. Anything else on GET is the app.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

// The same baseline firebase.json gives the shared site. No CSP here: the
// company's presign host and IdP are only known per deployment.
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000',
}

function isApi(pathname) {
  return API_PREFIXES.some((p) => pathname === p.replace(/\/$/, '') || pathname.startsWith(p))
}

/** A file under `root` for this URL path, or null. Never a path outside it. */
async function staticFile(root, pathname) {
  let rel
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (rel.includes('\0')) return null
  const full = normalize(join(root, rel))
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) return null
  try {
    const info = await stat(full)
    return info.isFile() ? full : null
  } catch {
    return null
  }
}

function serveFile(res, file, method) {
  const immutable = file.includes(`${sep}assets${sep}`)
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

/**
 * @param {object} o
 * @param {object} o.db              stack/sqlite.mjs (or Cloudflare D1)
 * @param {string} o.origin          the public https origin of this server
 * @param {string} o.sessionSecret
 * @param {string} o.dataKeyMaster
 * @param {Function|null} o.mail     ({ to, subject, text }) => { sent: boolean }
 * @param {string} [o.staticDir]     the built app; omitted means API only
 * @param {string} [o.blobDir]       where uploaded files are kept on disk
 * @param {object} [o.bootstrap]     { orgName, adminEmail, adminPassword } for first start
 */
export async function createDedicatedApp({
  db,
  origin,
  sessionSecret,
  dataKeyMaster,
  mail = null,
  staticDir = '',
  blobDir = '',
  bootstrap = null,
  fetchImpl,
}) {
  await applySchema(db)
  const engine = createEngine(db)
  const created = bootstrap ? await bootstrapOrganization(engine, db, bootstrap) : { created: false }

  const blobStore = blobDir
    ? createBlobStore({ dir: blobDir, key: blobKeyFrom(sessionSecret), origin })
    : null
  const host = createOwnStackServer({
    engine,
    db,
    sessionSecret,
    origin,
    blobStore,
    dataKeyMaster,
    mail,
    fetchImpl,
  })
  const delegate = host.listeners('request')[0]
  host.removeAllListeners('request')

  const root = staticDir ? normalize(staticDir) : ''
  host.on('request', async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        url.pathname === '/runtime-config.js'
      ) {
        res.writeHead(200, {
          ...BASE_HEADERS,
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        return res.end(
          req.method === 'HEAD' ? undefined : runtimeConfigScript({ origin, resetByEmail: Boolean(mail) })
        )
      }
      if (root && (req.method === 'GET' || req.method === 'HEAD') && !isApi(url.pathname)) {
        const file =
          (url.pathname !== '/' && (await staticFile(root, url.pathname))) ||
          // A client route (/portal, /settings): the app decides, as on Hosting.
          (await staticFile(root, '/index.html'))
        if (file) return serveFile(res, file, req.method)
      }
      return delegate(req, res)
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 'internal', message: 'request failed' }))
    }
  })

  return { server: host, created, engine, blobStore }
}
