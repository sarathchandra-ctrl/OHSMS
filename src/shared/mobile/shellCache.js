// What the production service worker may store.
//
// The worker exists so a phone that has opened the app once can still paint
// the shell in a dead spot on site. It must not become a second cache of
// account or equipment data. Firebase Auth, Firestore, Storage and App Check
// are requests to Google; they already have the SDK's own persistence, which
// is off unless VITE_OFFLINE_CACHE is set. Intercepting them here would replay
// one person's responses to the next person on the device, or hide a rules
// change behind a cached allow. Anything that is not this origin's static
// shell is passed straight through.

// v2: v1 may hold index.html saved as a script chunk; activate drops other names.
export const SHELL_CACHE = 'ohsms-shell-v2'

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
const PASS_HOST_SUFFIXES = [
  'googleapis.com',
  'gstatic.com',
  'google.com',
  'recaptcha.net',
  'firebaseio.com',
  'sentry.io',
]

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
