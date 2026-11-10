// Who may ask the server for a site's weather, and how the answer is cached.
//
// Ported from the Cloud Functions tier (functions/lib/siteWeatherCall.js),
// where it was the fetchSiteWeather callable. The weather screens, the portal
// widget and the site cards call it; the browser never calls Open-Meteo.
//
// Open-Meteo is a public forecast with no API key, so the answer is not a
// secret. What is guarded is the server being used as an open proxy: the
// caller must be an approved account past its temporary password, the
// coordinate must be the ~1 km square of a site that account can already see,
// and fetches are rate-limited per person (cache hits are free).
//
// Pure apart from the edges passed in, so every refusal is tested without a
// network or a database.

import { gridKey, requestPoint } from './openMeteo.js'
import { cachedObservation } from './weatherCacheDoc.js'

// One page of sites is the normal load. 120 provider fetches per ten minutes
// leaves room for a first pass over a large register and refuses a loop.
export const WEATHER_FETCH_LIMIT = 120
export const WEATHER_FETCH_WINDOW_S = 10 * 60

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

/**
 * The six-hour Asia/Kolkata slot an instant falls in, e.g. 2026-11-10T06+0530.
 * One reading per square per slot: two screens asking an hour apart show the
 * same observation instead of two forecast hours.
 */
export function weatherBucket(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const ist = new Date(d.getTime() + IST_OFFSET_MS)
  const hour = String(Math.floor(ist.getUTCHours() / 6) * 6).padStart(2, '0')
  const y = ist.getUTCFullYear()
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0')
  const day = String(ist.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}T${hour}+0530`
}

/** The same reach the app gives (resolveAccessibleSites): admin, posting, or a grant. */
export function profileReachesSite(profile, site) {
  if (!profile || !site) return false
  if (profile.role === 'admin') return true
  const a = profile.access || {}
  const has = (list, v) => Array.isArray(list) && Boolean(v) && list.includes(v)
  return (
    (Boolean(site.id) && profile.siteId === site.id) ||
    has(a.sites, site.id) ||
    has(a.regions, site.region) ||
    has(a.entities, site.entity)
  )
}

export function callerReachesPoint(profile, sites, key) {
  if (!key) return false
  return (sites || []).some(
    (site) => gridKey(Number(site?.lat), Number(site?.lng)) === key && profileReachesSite(profile, site)
  )
}

/**
 * The job body. `profile` is the caller's live profile; `sites` the site
 * register; `cache` { get(key), set(key, slot, obs) }; `takeRate()` resolves
 * false when the caller is over the limit. Returns { body } or
 * { error, message }.
 */
export async function serveSiteWeather({
  profile,
  data,
  sites,
  cache,
  fetchImpl,
  takeRate,
  nowMs = Date.now(),
} = {}) {
  if (!profile || profile.status !== 'approved') {
    return { error: 'permission-denied', message: 'Your account is not approved.' }
  }
  if (profile.mustChangePassword === true) {
    return { error: 'permission-denied', message: 'Change your password before using this.' }
  }
  const key = gridKey(Number(data?.lat), Number(data?.lng))
  if (!key) return { error: 'invalid-argument', message: 'A latitude and longitude are required.' }
  if (!callerReachesPoint(profile, sites, key)) {
    return { error: 'permission-denied', message: 'That location is not a site you can view.' }
  }
  const [lat, lng] = key.split(',').map(Number)
  const slot = weatherBucket(new Date(nowMs))
  if (cache && slot) {
    const hit = cachedObservation(await cache.get(key), slot)
    if (hit) return { body: { obs: hit.slot ? hit : { ...hit, slot } } }
  }
  if (takeRate && !(await takeRate())) return { body: { obs: null, limited: true } }
  const result = await requestPoint({ key, lat, lng }, { cache, slot, fetchImpl, now: nowMs })
  if (!result.ok && result.retry) return { body: { obs: null, limited: true } }
  return { body: { obs: result.obs || null } }
}
