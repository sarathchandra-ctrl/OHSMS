// Current conditions for a coordinate, via the fetchSiteWeather function.
// The browser never calls Open-Meteo. Coordinates are still rounded to ~1 km
// before they leave this page, the same two decimals as gridKey in
// stack/lib/openMeteo.js. The server checks the point against a site's
// square, so the two roundings have to match or a site on an edge is refused
// its own screen.
//
// The cache is what makes a map usable. A hundred pins in one city share a
// handful of grid squares, and hovering the same pin twice costs nothing.
// A failure is never stored, so a bad minute cannot be inherited by the next
// session.

import { fetchSiteWeather } from '../../../shared/functions'
import { weatherSlot } from './observedAt'

const GRID = 2
const TTL_MS = 15 * 60 * 1000
const COOLOFF_MS = 60_000

// v3 drops readings stored under v2. Those came from the previous provider,
// and a widget that kept one while the page fetched an Open-Meteo hour is
// the mismatch this key exists to end.
const STORE_KEY = 'wehs:weather:v3'
const STORE_MAX = 200

const cache = new Map()
const inflight = new Map()
let coolOffUntil = 0
let hydrated = false
let transport = null

const keyFor = (lat, lng) => `${lat.toFixed(GRID)},${lng.toFixed(GRID)}`

function store() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function hydrate() {
  if (hydrated) return
  hydrated = true
  try {
    const saved = JSON.parse(store()?.getItem(STORE_KEY) || '{}')
    const now = Date.now()
    for (const [key, entry] of Object.entries(saved)) {
      if (entry?.obs && now - entry.at < TTL_MS) cache.set(key, entry)
    }
  } catch {
    /* a corrupt or unreadable cache is just a cold one */
  }
}

function persist() {
  const s = store()
  if (!s) return
  try {
    const entries = [...cache.entries()].filter(([, e]) => e.obs).sort((a, b) => b[1].at - a[1].at)
    s.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(entries.slice(0, STORE_MAX))))
  } catch {
    /* quota or private mode — the in-memory cache still works */
  }
}

/** Test seam — replace the callable. Production uses fetchSiteWeather. */
export function _setWeatherTransport(fn) {
  transport = fn
}

export function _reloadWeatherCache() {
  cache.clear()
  inflight.clear()
  coolOffUntil = 0
  hydrated = false
}

export function _clearWeatherCache() {
  cache.clear()
  inflight.clear()
  coolOffUntil = 0
  hydrated = false
  try {
    store()?.removeItem(STORE_KEY)
  } catch {
    /* nothing to clear */
  }
}

function fresh(entry) {
  if (!entry?.obs) return false
  const slot = weatherSlot(new Date())
  if (entry.obs.slot) return entry.obs.slot === slot
  return Date.now() - entry.at < TTL_MS
}

function unwrap(data) {
  if (data && (Object.prototype.hasOwnProperty.call(data, 'obs') || data.limited)) return data
  return { obs: data || null }
}

async function requestObservation(lat, lng) {
  if (transport) return unwrap(await transport(lat, lng))
  return unwrap(await fetchSiteWeather({ lat, lng }))
}

/**
 * Fetch current conditions near a coordinate.
 *
 * Resolves to `null` rather than throwing when the service is unreachable:
 * weather is a decoration on a site card, and a map that fails to render
 * because a third party is down would be a worse outcome than a card with no
 * weather on it.
 */
export async function fetchWeather(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  hydrate()
  const key = keyFor(lat, lng)
  const [gLat, gLng] = key.split(',').map(Number)

  const hit = cache.get(key)
  if (hit && fresh(hit)) return hit.obs
  if (Date.now() < coolOffUntil) return hit ? hit.obs : null
  if (inflight.has(key)) return inflight.get(key)

  const req = (async () => {
    try {
      const data = await requestObservation(gLat, gLng)
      if (data?.limited) {
        coolOffUntil = Date.now() + COOLOFF_MS
        return hit ? hit.obs : null
      }
      const obs = data?.obs || null
      if (!obs) return null
      cache.set(key, { at: Date.now(), obs })
      persist()
      return obs
    } catch {
      return null
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, req)
  return req
}
