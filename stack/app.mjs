// The organization's server, as deployed: the gateway the app talks to
// (/data, /rpc, /presign, /blob, sign-in), first-run /setup, and the built app
// itself, on one origin. docs/SELF-HOSTING.md.
//
// stack/main.mjs reads the environment and calls this. Everything here takes
// its database and settings as arguments, so the tests run it on PGlite.
//
// State survives a restart (stack/state.mjs), the demo OIDC issuer is off,
// and the sign-in configuration connected at /setup is restored at start-up.
// The built app is served here too, so the session redirect, the SAML
// assertion and the app's /data calls are all same-origin. When the app is
// served from Cloudflare instead (worker/index.js), the Worker forwards these
// same paths here, so they stay same-origin to the browser.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { applySchema, createEngine } from './engine.mjs'
import { createOwnStackServer } from './server.mjs'
import { openState } from './state.mjs'
import { blobKeyFrom, createBlobStore } from './blobs.mjs'

// Paths the host answers. Anything else on GET is the app.
// worker/index.js forwards the same list; keep the two in step.
export const API_PREFIXES = [
  '/data',
  '/auth/',
  '/presign',
  '/blob',
  '/rpc/',
  '/oidc/',
  '/.well-known/',
  '/setup',
  '/scim/',
  '/health',
]

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
  '.apk': 'application/vnd.android.package-archive',
}

// The same baseline firebase.json gives the shared site. No CSP here: the
// company's presign host and IdP are only known per deployment.
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000',
}

/**
 * The settings the app reads before it starts (src/shared/runtimeConfig.js),
 * from what this server is now rather than from how its image was built: the
 * sign-in method follows the IdP connected at /setup, and the gateway is this
 * origin.
 *
 * Every value is a JSON string, and `<` is escaped, so nothing a request
 * carried can close the script or start another one.
 */
export function runtimeConfigScript({ origin, auth }) {
  const method = ['saml', 'oidc', 'supabase'].includes(auth?.method) ? auth.method : 'none'
  const config = {
    DATA_DRIVER: 'postgres',
    DATA_GATEWAY: origin,
    STORAGE_DRIVER: 's3',
    S3_PRESIGN_ENDPOINT: `${origin}/presign`,
    AUTH_METHOD: method,
    AUTH_TOTP: 'off',
  }
  const json = JSON.stringify(config).replace(/</g, '\\u003c')
  return `window.__OHSMS_CONFIG__ = ${json};\n`
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
 * @param {object} o.db              PGlite or stack/pg.mjs
 * @param {Buffer} o.stateKey        32 bytes; seals secrets at rest
 * @param {string} o.origin          the public https origin of this environment
 * @param {string} o.sessionSecret
 * @param {string} o.controlToken    the one-time setup code for /setup
 * @param {string} o.dataKeyMaster
 * @param {string} [o.blobDir]       where uploaded files are kept on disk
 * @param {Function|null} o.mail     ({ to, subject, text }) => { sent: boolean }
 * @param {string} [o.staticDir]     the built app; omitted means API only
 * @param {boolean} [o.oidcAcceptUnverifiedEmail]  OIDC_ACCEPT_UNVERIFIED_EMAIL
 */
export async function createDedicatedApp({
  db,
  stateKey,
  origin,
  sessionSecret,
  controlToken,
  dataKeyMaster,
  mail = null,
  staticDir = '',
  blobDir = '',
  oidcAcceptUnverifiedEmail = false,
}) {
  await applySchema(db)
  const engine = createEngine(db)
  const state = await openState(db, { key: stateKey })
  // The sign-in the app is told about follows the one the host holds.
  let currentAuth = state.auth || { method: 'none' }

  const host = createOwnStackServer({
    engine,
    db,
    sessionSecret,
    origin,
    // Before /setup names an IdP, there is none: sign-in answers 503.
    auth: currentAuth,
    controlToken,
    blobStore: blobDir
      ? createBlobStore({ dir: blobDir, key: blobKeyFrom(sessionSecret), origin })
      : null,
    dataKeyMaster,
    mail,
    oidcAcceptUnverifiedEmail,
    demoIssuer: false,
    // Tell the app about a sign-in only once it is stored: if the write
    // failed, a restart would bring back the old one and the two would differ.
    onAuthChange: async (auth) => {
      await state.saveAuth(auth)
      currentAuth = auth
    },
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
          // Changes the moment /setup connects an IdP.
          'Cache-Control': 'no-store',
        })
        return res.end(
          req.method === 'HEAD'
            ? undefined
            : runtimeConfigScript({ origin, auth: currentAuth })
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

  return { server: host, state }
}
