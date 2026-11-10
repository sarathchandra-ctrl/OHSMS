// What the production service worker may store.
//
// The worker exists so a phone that has opened the app once can still paint
// the shell in a dead spot on site. It must not become a second cache of
// account or equipment data. The server's endpoints — records (/data), jobs
// (/rpc), sign-in (/auth), upload links (/presign), stored files (/blob) and
// /health — are passed straight through and never stored. Storing them would
// replay one person's records or files to the next person on a shared device,
// keep a file after its download link expired, or hide an access change
// behind a cached answer. Anything that is not this origin's static shell is
// passed straight through.

// Renamed whenever an old cache may hold something it should not; activate
// drops every other name. v2: v1 may hold index.html saved as a script chunk.
// v3: v2 may hold stored files and server answers, from before /blob and the
// server endpoints were passed through.
export const SHELL_CACHE = 'ohsms-shell-v3'

export const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/brand/logo.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
]

// Hosts that carry auth, Firestore, Storage, App Check, reCAPTCHA or error
// reporting. A same-origin check already skips these when the page origin is
// the app; the suffix list is the backstop for a request whose origin was not
// passed in, and for a bug that compared the wrong origin.
const PASS_HOST_SUFFIXES = ['sentry.io']

// This origin's server endpoints (stack/handler.mjs, worker/index.js).
const SERVER_PATHS = ['/data', '/presign', '/blob', '/health']
const SERVER_PREFIXES = ['/rpc/', '/auth/']

/**
 * @returns {'pass' | 'asset' | 'navigate'}
 *   pass     — do not touch the request
 *   asset    — hashed script, style, font or icon; safe to keep
 *   navigate — an app route; network first, then the cached shell
 */
export function shellCacheDecision(rawUrl, { method = 'GET', origin = '' } = {}) {
  if (!rawUrl || method !== 'GET') return 'pass'
  let url
  try {
    url = new URL(rawUrl, origin || 'https://app.invalid')
  } catch {
    return 'pass'
  }
  if (origin && url.origin !== origin) return 'pass'
  const host = url.hostname
  if (PASS_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return 'pass'
  }
  // Firebase Hosting's reserved namespace. The auth handler lives here when
  // the app and the auth domain share a host, and caching it would replay a
  // sign-in.
  if (url.pathname.startsWith('/__/')) return 'pass'
  if (SERVER_PATHS.includes(url.pathname) || SERVER_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    return 'pass'
  }
  // The uptime probe. A cached 200 is a lie about a deploy that is down.
  if (url.pathname === '/health.json') return 'pass'
  // A dedicated environment's settings (stack/app.mjs), written when it goes
  // live. Kept as an asset, the phone that opened the app before the handoff
  // would keep "Not set up yet" and the old sign-in method indefinitely.
  if (url.pathname === '/runtime-config.js') return 'pass'
  // Legal pages are static documents. The navigate fallback would serve the
  // app shell, and a crawler or a signed-out visitor would not see the policy.
  if (
    url.pathname === '/privacy' ||
    url.pathname === '/privacy/' ||
    url.pathname === '/privacy.html'
  ) {
    return 'pass'
  }
  if (url.pathname === '/terms' || url.pathname === '/terms/' || url.pathname === '/terms.html') {
    return 'pass'
  }
  // Store settings and legacy downloads must never fall back to the app shell.
  if (url.pathname === '/store.json') return 'pass'
  if (url.pathname.startsWith('/downloads/')) return 'pass'
  if (/\.(?:js|css|woff2?|png|svg|webp|ico|webmanifest)$/i.test(url.pathname)) return 'asset'
  if (url.pathname === '/manifest.webmanifest') return 'asset'
  return 'navigate'
}
