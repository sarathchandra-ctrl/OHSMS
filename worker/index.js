// The Cloudflare front door for one organization's OHSMS.
//
// Cloudflare serves the built app (dist/) from its edge, and the server paths
// below — sign-in, /data, /rpc, /presign, /blob, /health and
// /runtime-config.js — run inside this Worker (worker/server.js), with the
// database in Cloudflare D1 (the DB binding) and files in R2 (FILES). The
// browser only ever sees this one hostname, so the app's fetches are
// same-origin. There is no machine to manage.

// Keep in step with API_PREFIXES in stack/runtimeConfig.mjs. /scim is not
// here on purpose: the server does not serve it (worker/index.test.js).
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

// Without the D1 binding there is no server to answer: say so, plainly,
// rather than a 500 from a missing binding.
function notConfigured() {
  return new Response(
    JSON.stringify({ code: 'unavailable', message: 'The DB binding is not configured on the Worker' }),
    { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  )
}

export default {
  // The cron triggers in wrangler.jsonc: the server's own jobs, on a clock
  // (stack/schedule.mjs).
  async scheduled(event, env, ctx) {
    if (!env.DB) return
    const { runScheduledOnCloudflare } = await import('./server.js')
    ctx.waitUntil(runScheduledOnCloudflare(event.cron, env))
  },

  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url)
    if (isServerPath(pathname)) {
      if (!env.DB) return notConfigured()
      const { serveOnCloudflare } = await import('./server.js')
      return serveOnCloudflare(request, env, ctx)
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
