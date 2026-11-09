// The Cloudflare front door for one organization's OHSMS.
//
// Two ways to run the server, chosen by the Worker's settings:
//   1. On Cloudflare (DB binding present, ORIGIN_URL empty): the server
//      runs inside this Worker (worker/server.js), with the database in
//      Cloudflare D1 and files in R2. No machine to manage.
//   2. On the organization's own server (ORIGIN_URL set): this Worker forwards
//      the server paths to it through a Cloudflare Tunnel, as described below.
//
// Cloudflare serves the built app (dist/) from its edge. Everything the app
// asks of its server — sign-in, /data, /rpc, /presign, /blob and
// /runtime-config.js — is forwarded to the organization's own server, which
// Cloudflare reaches through a Cloudflare Tunnel (cloudflared, next to the
// server; selfhost/compose.yaml runs it). The browser only ever sees this one
// hostname, so the app.s
// fetches stay same-origin, exactly as when the server serves the app itself.
//
// Settings (wrangler.jsonc "vars", or the dashboard):
//   ORIGIN_URL               https URL of the Tunnel hostname for the server,
//                            e.g. https://ehs-origin.example.com
// Secrets (wrangler secret put …), optional but recommended:
//   CF_ACCESS_CLIENT_ID      a Cloudflare Access service token protecting the
//   CF_ACCESS_CLIENT_SECRET  Tunnel hostname, so only this Worker can reach it
//
// The server must be started with PUBLIC_ORIGIN set to THIS Worker's address
// (the hostname people type), because it builds every redirect and file URL
// on it.

// Keep in step with API_PREFIXES in stack/app.mjs.
export const SERVER_PREFIXES = [
  '/data',
  '/auth/',
  '/presign',
  '/blob',
  '/rpc/',
  '/health',
  '/runtime-config.js',
]

/** A prefix ending in / covers everything under it; any other is one exact path. */
export function isServerPath(pathname) {
  return SERVER_PREFIXES.some((p) => (p.endsWith('/') ? pathname.startsWith(p) : pathname === p))
}

// Hop-by-hop and Cloudflare-managed headers are not forwarded as they came.
const DROP = [
  'host',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  // Never let a browser present an Access credential of its own.
  'cf-access-client-id',
  'cf-access-client-secret',
]

export async function forward(request, env) {
  const origin = String(env.ORIGIN_URL || '').replace(/\/$/, '')
  if (!/^https:\/\//.test(origin)) {
    return new Response(
      JSON.stringify({
        code: 'unavailable',
        message: 'ORIGIN_URL is not configured on the Worker',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
    )
  }
  const incoming = new URL(request.url)
  const target = new URL(incoming.pathname + incoming.search, origin)

  const headers = new Headers(request.headers)
  for (const name of DROP) headers.delete(name)
  headers.set('X-Forwarded-Host', incoming.host)
  headers.set('X-Forwarded-Proto', incoming.protocol.replace(':', ''))
  const ip = request.headers.get('cf-connecting-ip')
  if (ip) headers.set('X-Forwarded-For', ip)
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID)
    headers.set('CF-Access-Client-Secret', env.CF_ACCESS_CLIENT_SECRET)
  }

  const hasBody = !['GET', 'HEAD'].includes(request.method)
  const res = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    // The server's 302s (IdP round trips, #session) go to the browser as they are.
    redirect: 'manual',
  })
  // Responses from the server are never cached at the edge: they carry
  // sessions, records and signed file links.
  const out = new Response(res.body, res)
  if (!out.headers.has('Cache-Control')) out.headers.set('Cache-Control', 'no-store')
  return out
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url)
    if (isServerPath(pathname)) {
      if (!env.ORIGIN_URL && env.DB) {
        const { serveOnCloudflare } = await import('./server.js')
        return serveOnCloudflare(request, env, ctx)
      }
      return forward(request, env)
    }
    // Everything else is the app. Unknown paths fall back to index.html
    // (not_found_handling in wrangler.jsonc).
    const res = await env.ASSETS.fetch(request)
    if (pathname.startsWith('/assets/') && isHtml(res)) return missingAsset()
    return res
  },
}

function isHtml(res) {
  return /^text\/html\b/i.test(res.headers.get('Content-Type') || '')
}

// A script from a previous build is gone after every deploy. Answering with
// index.html (200, and /assets/* is cached for a year as immutable) let a tab
// still on the old build — and its service worker — keep that HTML as the
// module's code, so the module never loaded. A 404 lets the import fail
// cleanly, and the app reloads onto the current build (ErrorBoundary).
function missingAsset() {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
