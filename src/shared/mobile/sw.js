import { PRECACHE_URLS, SHELL_CACHE, shellCacheDecision } from './shellCache.js'

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await cache.match(request)
  const fetching = fetch(request)
    .then((response) => {
      // Never keep a page as a script: the host's SPA fallback answered a
      // missing chunk with index.html, and caching it broke the module for good.
      const type = response?.headers.get('Content-Type') || ''
      if (response && response.ok && response.type === 'basic' && !/^text\/html\b/i.test(type)) {
        cache.put(request, response.clone())
      }
      return response
    })
    .catch(() => null)
  return cached || (await fetching) || Response.error()
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const fresh = await fetch(request)
    if (fresh && fresh.ok && fresh.type === 'basic') cache.put(request, fresh.clone())
    return fresh
  } catch {
    const cached = (await cache.match(request)) || (await cache.match('/index.html'))
    if (cached) return cached
    return Response.error()
  }
}

function installWorker(worker) {
  worker.addEventListener('install', (event) => {
    event.waitUntil(
      caches
        .open(SHELL_CACHE)
        .then((cache) => cache.addAll(PRECACHE_URLS))
        .then(() => worker.skipWaiting())
    )
  })

  worker.addEventListener('activate', (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((keys) =>
          Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)))
        )
        .then(() => worker.clients.claim())
    )
  })

  worker.addEventListener('fetch', (event) => {
    const decision = shellCacheDecision(event.request.url, {
      method: event.request.method,
      origin: worker.location.origin,
    })
    if (decision === 'pass') return
    if (decision === 'asset') {
      event.respondWith(staleWhileRevalidate(event.request))
      return
    }
    event.respondWith(networkFirstNavigation(event.request))
  })
}

// Importing this module from a test or from the page must not register
// listeners. The worker is the only place ServiceWorkerGlobalScope exists.
if (
  typeof ServiceWorkerGlobalScope !== 'undefined' &&
  globalThis instanceof ServiceWorkerGlobalScope
) {
  installWorker(globalThis)
}
