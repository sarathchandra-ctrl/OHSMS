// Current conditions for a coordinate, from Open-Meteo's public forecast and
// air-quality APIs. No API key. GET only.
//
// The browser never calls these hosts. The server's fetchSiteWeather job does
// (stack/lib/siteWeather.js), and the page only sees the observation below.
// Restored from the Cloud Functions tier, where the same code served the site
// screen and the weather digest. A missing key must not block
// the read: callers used to pass one for the previous provider, and a key on
// this URL would be a credential in the query string. options.apiKey is
// ignored.
//
// Coordinates are rounded to two decimals (~1 km) before they leave. The
// exact position of a workplace is not part of the request. The site name,
// org and id are not either.
//
// One decimal (~11 km) was tried for a day (v2.0.16 to v2.0.18) on the theory
// that the request count was spending the free daily quota. It was not: the
// refusals came from requests reaching Open-Meteo from several addresses at
// once, and that has been fixed at its source. Two decimals keeps each site's reading
// to its own square, and the daily-limit stop in fetchGrids below still ends
// a pass that does run out.
//
// Two forecast models:
//   icon_global — temperature, humidity, hourly precipitation, CAPE, WMO
//     weather code, and wind. Codes 95, 96 and 99 are thunderstorms. 99 is
//     heavy hail. The previous provider's warning field only carried 95 and
//     96, so 99 has to be copied here or a named storm arrives as quiet CAPE.
//   gfs_global — the same fields, used only when ICON answered and had no
//     usable weather numbers (an empty 204, or JSON with no numbers). A
//     429, 408 or 5xx does not open GFS. A rate limit must not spend the
//     budget twice.
//
// Air quality is a second host. us_aqi is the 0–500 US AQI. When that series
// is missing, PM2.5 and PM10 (µg/m³) are converted with the US EPA
// breakpoints, which are the same scale, and the worse one is kept. UV,
// European AQI and visibility are not requested.
//
// Hourly precipitation is already millimetres in the preceding hour, so it
// is the mm/h the rain cuts compare. It is not divided by three, and the
// 15-minute sum is not requested. The earlier Open-Meteo client treated that
// 15-minute sum as a rate and dropped wet hours under the mail line.
//
// Open-Meteo's apparent_temperature adds a solar-radiation term. Apparent
// temperature here is the Bureau of Meteorology form of Steadman, from air
// temperature, humidity and wind, with no radiation, so the heat and cold
// cuts still see the feels-like they were tuned on. Wind is fetched only for
// that. It is not an alert. The code is copied onto lightningCode only. A
// raw weatherCode field is not a hazard.
//
// A failure is not a calm site. requestPoint returns retry on 429, 408, 5xx
// and a network error. fetchGrids lists those keys instead of storing an
// empty reading as clear.
//
// requestPoint checks the slot cache first (weatherCache.js). A hit is the
// reading already shown on the screen, not a second ask that can land on
// another forecast hour.

import { cachedObservation } from './weatherCacheDoc.js'

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality'
const USER_AGENT = 'OHSMS-weather/1.0 (contact: info@weehs.org)'
const TIMEOUT_MS = 12_000

export const WEATHER_MODEL = 'icon_global'
export const FALLBACK_MODEL = 'gfs_global'

export const HOURLY_WEATHER = [
  'temperature_2m',
  'relative_humidity_2m',
  'precipitation',
  'cape',
  'weather_code',
  'wind_speed_10m',
]
export const HOURLY_AIR = ['us_aqi', 'pm2_5', 'pm10']

export const FETCH_CONCURRENCY = 3
const MAX_ATTEMPTS = 4
const BACKOFF_CAP_MS = 20_000

// US EPA breakpoint rows: [concLow, concHigh, indexLow, indexHigh]. Used only
// when the air-quality API does not send us_aqi. The occupational bands
// applied later are not these EPA category names.
const PM25_BREAKS = [
  [0.0, 12.0, 0, 50],
  [12.1, 35.4, 51, 100],
  [35.5, 55.4, 101, 150],
  [55.5, 150.4, 151, 200],
  [150.5, 250.4, 201, 300],
  [250.5, 350.4, 301, 400],
  [350.5, 500.4, 401, 500],
]
const PM10_BREAKS = [
  [0, 54, 0, 50],
  [55, 154, 51, 100],
  [155, 254, 101, 150],
  [255, 354, 151, 200],
  [355, 424, 201, 300],
  [425, 504, 301, 400],
  [505, 604, 401, 500],
]

const WEATHER_NUMBERS = ['temperature_2m', 'precipitation', 'cape', 'weather_code']

// Temperature first, then anything else on that hour. A missing temperature
// walks back to the latest earlier hour that has one. A later hour is used
// only when nothing at or before the current step exists, so a forecast hour
// cannot masquerade as now while an earlier reading is sitting in the series.
const HOUR_FIELDS = [
  'temperature_2m',
  'precipitation',
  'cape',
  'relative_humidity_2m',
  'weather_code',
]

export function gridKey(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return ''
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return ''
  return `${lat.toFixed(2)},${lng.toFixed(2)}`
}

function locationParams(lat, lng) {
  const key = gridKey(lat, lng)
  if (!key) return null
  const [latitude, longitude] = key.split(',')
  return { latitude, longitude }
}

function withTime(params) {
  params.set('timeformat', 'unixtime')
  params.set('timezone', 'GMT')
  params.set('past_hours', '6')
  params.set('forecast_hours', '6')
  return params
}

/** Forecast URL for one rounded coordinate. Empty when the point is not one. */
export function forecastUrl(lat, lng, model) {
  const loc = locationParams(lat, lng)
  if (!loc || !model) return ''
  const params = new URLSearchParams({
    latitude: loc.latitude,
    longitude: loc.longitude,
    hourly: HOURLY_WEATHER.join(','),
    wind_speed_unit: 'ms',
    precipitation_unit: 'mm',
    temperature_unit: 'celsius',
  })
  withTime(params)
  params.set('models', model)
  return `${FORECAST_URL}?${params.toString()}`
}

/** Air-quality URL. Same clock window as the forecast, no weather fields. */
export function airQualityUrl(lat, lng) {
  const loc = locationParams(lat, lng)
  if (!loc) return ''
  const params = new URLSearchParams({
    latitude: loc.latitude,
    longitude: loc.longitude,
    hourly: HOURLY_AIR.join(','),
  })
  withTime(params)
  return `${AIR_URL}?${params.toString()}`
}

function pick(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Latest step at or before `now`. A series that is entirely in the future uses the first step. */
export function stepIndex(ts, now) {
  if (!Array.isArray(ts) || !ts.length) return -1
  let best = -1
  for (let i = 0; i < ts.length; i += 1) {
    const raw = Number(ts[i])
    if (!Number.isFinite(raw)) continue
    const ms = raw < 1e12 ? raw * 1000 : raw
    if (ms <= now) best = i
  }
  return best >= 0 ? best : 0
}

function seriesValue(hourly, name, idx) {
  if (!hourly || idx < 0) return null
  const series = hourly[name]
  if (!Array.isArray(series) || idx >= series.length) return null
  return pick(series[idx])
}

function hourHas(hourly, idx) {
  return HOUR_FIELDS.some((name) => seriesValue(hourly, name, idx) != null)
}

export function hourIndex(hourly, preferred) {
  if (!hourly || preferred < 0) return preferred
  const hasTemp = (idx) => seriesValue(hourly, 'temperature_2m', idx) != null
  if (hasTemp(preferred)) return preferred
  for (let i = preferred - 1; i >= 0; i -= 1) if (hasTemp(i)) return i
  if (hourHas(hourly, preferred)) return preferred
  for (let i = preferred - 1; i >= 0; i -= 1) if (hourHas(hourly, i)) return i
  const len = Array.isArray(hourly.time) ? hourly.time.length : 0
  for (let i = preferred + 1; i < len; i += 1) if (hasTemp(i) || hourHas(hourly, i)) return i
  return preferred
}

/** Air-quality step closest to the weather hour, so AQI is not a different clock. */
export function nearestIndex(ts, targetMs) {
  if (!Array.isArray(ts) || !ts.length || !Number.isFinite(targetMs)) return -1
  let best = -1
  let bestDist = Infinity
  for (let i = 0; i < ts.length; i += 1) {
    const ms = msAt(ts, i)
    if (!Number.isFinite(ms)) continue
    const dist = Math.abs(ms - targetMs)
    if (dist < bestDist) {
      best = i
      bestDist = dist
    }
  }
  return best
}

function msAt(ts, idx) {
  if (!Array.isArray(ts) || idx < 0) return NaN
  const raw = Number(ts[idx])
  if (!Number.isFinite(raw)) return NaN
  return raw < 1e12 ? raw * 1000 : raw
}

function subIndex(conc, rows) {
  if (conc == null || !Number.isFinite(conc) || conc < 0) return null
  let row = rows.find((r) => conc >= r[0] && conc <= r[1])
  if (!row) row = conc > rows[rows.length - 1][1] ? rows[rows.length - 1] : rows[0]
  const [cLo, cHi, iLo, iHi] = row
  if (conc > cHi) return 500
  const index = ((iHi - iLo) / (cHi - cLo)) * (conc - cLo) + iLo
  return Math.round(Math.min(500, Math.max(0, index)))
}

/** US AQI (0–500) from particle concentrations, the worse of the two. */
export function aqiFromParticles(pm25, pm10) {
  const parts = [subIndex(pm25, PM25_BREAKS), subIndex(pm10, PM10_BREAKS)].filter((n) => n != null)
  if (!parts.length) return null
  return Math.max(...parts)
}

/**
 * Bureau of Meteorology apparent temperature (°C).
 * AT = Ta + 0.33e − 0.70ws − 4.00, with e from relative humidity.
 * Without humidity the air temperature is returned unchanged. Wind is m/s.
 */
export function apparentTemperatureC(tempC, rh, windMs) {
  if (tempC == null) return null
  if (rh == null) return tempC
  const vapour = (rh / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC))
  const ws = windMs != null && windMs >= 0 ? windMs : 0
  return tempC + 0.33 * vapour - 0.7 * ws - 4
}

function stamp(ts, idx) {
  if (!Array.isArray(ts) || idx < 0) return ''
  const raw = Number(ts[idx])
  if (!Number.isFinite(raw)) return ''
  const ms = raw < 1e12 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

function lightningCodeOf(code) {
  if (code === 95 || code === 96 || code === 99) return code
  return null
}

/**
 * Shape one forecast payload and one air-quality payload into the observation
 * assessWeather reads. Every weather field comes from one hour.
 */
export function normalizeObservation(weather, air, now = Date.now()) {
  if (!weather && !air) return null
  const wHourly = weather?.hourly
  const wIdx = wHourly ? hourIndex(wHourly, stepIndex(wHourly.time, now)) : -1
  const weatherMs = msAt(wHourly?.time, wIdx)
  const aHourly = air?.hourly
  const aIdx = aHourly
    ? Number.isFinite(weatherMs)
      ? nearestIndex(aHourly.time, weatherMs)
      : stepIndex(aHourly.time, now)
    : -1
  const atW = (name) => seriesValue(wHourly, name, wIdx)
  const atA = (name) => seriesValue(aHourly, name, aIdx)

  const tempC = atW('temperature_2m')
  const rhRaw = atW('relative_humidity_2m')
  const rh = rhRaw == null ? null : Math.min(100, Math.max(0, rhRaw))
  const windMs = atW('wind_speed_10m')
  const precip = atW('precipitation')

  let aqi = atA('us_aqi')
  let aqiSource = ''
  if (aqi != null && aqi >= 0) aqiSource = 'aqi'
  else {
    aqi = aqiFromParticles(atA('pm2_5'), atA('pm10'))
    if (aqi != null) aqiSource = 'pm'
  }

  return {
    tempC,
    apparentTempC: apparentTemperatureC(tempC, rh, windMs),
    precipMmHr: precip != null && precip >= 0 ? precip : null,
    capeJkg: atW('cape'),
    lightningCode: lightningCodeOf(atW('weather_code')),
    aqi: aqi != null && aqi >= 0 ? aqi : null,
    aqiSource,
    observedAt: stamp(wHourly?.time, wIdx) || stamp(aHourly?.time, aIdx),
  }
}

function readable(obs) {
  if (!obs) return false
  return [
    obs.tempC,
    obs.apparentTempC,
    obs.precipMmHr,
    obs.capeJkg,
    obs.lightningCode,
    obs.aqi,
  ].some((value) => value != null)
}

function hasWeather(json) {
  const hourly = json?.hourly
  if (!hourly || typeof hourly !== 'object') return false
  return WEATHER_NUMBERS.some(
    (name) => Array.isArray(hourly[name]) && hourly[name].some((v) => pick(v) != null)
  )
}

function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after')
  if (raw == null || raw === '') return 0
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const when = Date.parse(raw)
  if (Number.isNaN(when)) return 0
  return Math.max(0, when - Date.now())
}

// Open-Meteo answers a spent quota with 429 and a reason naming the window:
// minutely, hourly or daily. The first two clear inside a slot. The daily one
// clears at 00:00 UTC, so retrying it four times per grid on every tick only
// adds requests that cannot succeed.
async function dailyLimit(resp) {
  try {
    const body = typeof resp.text === 'function' ? await resp.text() : ''
    return /daily/i.test(String(body || ''))
  } catch {
    return false
  }
}

async function getJson(url, fetchImpl) {
  if (!url) return { ok: false, retry: false, retryAfterMs: 0, json: null }
  try {
    const resp = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const wait = retryAfterMs(resp.headers)
    if (resp.status === 204) {
      return { ok: false, empty: true, retry: false, retryAfterMs: 0, json: null }
    }
    if (!resp.ok) {
      const transient = resp.status === 429 || resp.status === 408 || resp.status >= 500
      const exhausted = resp.status === 429 && (await dailyLimit(resp))
      return {
        ok: false,
        retry: transient && !exhausted,
        exhausted,
        retryAfterMs: wait,
        json: null,
      }
    }
    return { ok: true, json: await resp.json(), retryAfterMs: 0 }
  } catch {
    return { ok: false, retry: true, retryAfterMs: 0, json: null }
  }
}

async function loadWeather(point, fetchImpl) {
  const icon = await getJson(forecastUrl(point.lat, point.lng, WEATHER_MODEL), fetchImpl)
  if ((icon.retry || icon.exhausted) && !hasWeather(icon.json)) return icon
  if (hasWeather(icon.json)) return icon
  const gfs = await getJson(forecastUrl(point.lat, point.lng, FALLBACK_MODEL), fetchImpl)
  if (hasWeather(gfs.json)) return gfs
  if (gfs.retry && !hasWeather(gfs.json)) return gfs
  return icon.json ? icon : gfs
}

function withSlot(obs, slot) {
  if (!obs) return obs
  if (!slot || obs.slot === slot) return obs.slot ? obs : { ...obs, slot }
  return { ...obs, slot }
}

/**
 * One point. `retry` means the caller should wait and try again. A 429 does
 * not fall through to a second model: that only spends the same budget faster.
 * `options.apiKey` is ignored. Open-Meteo does not take one.
 */
export async function requestPoint(point, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const nowMs = typeof options.now === 'number' ? options.now : Date.now()
  const slot = options.slot || ''
  if (!point?.key) return { ok: false, retry: false, retryAfterMs: 0, obs: null }
  if (options.cache && slot) {
    const doc = await options.cache.get(point.key)
    const hit = cachedObservation(doc, slot)
    if (hit) return { ok: true, obs: withSlot(hit, slot), cached: true, retryAfterMs: 0 }
  }

  const weather = await loadWeather(point, fetchImpl)
  if (weather.exhausted) {
    return { ok: false, retry: false, exhausted: true, retryAfterMs: 0, obs: null }
  }
  if (weather.retry && !hasWeather(weather.json)) {
    return { ok: false, retry: true, retryAfterMs: weather.retryAfterMs || 0, obs: null }
  }
  const air = await getJson(airQualityUrl(point.lat, point.lng), fetchImpl)
  const normalized = normalizeObservation(weather.json, air.json, nowMs)
  if (!readable(normalized)) {
    if (air.retry || weather.retry) {
      return {
        ok: false,
        retry: true,
        retryAfterMs: air.retryAfterMs || weather.retryAfterMs || 0,
        obs: null,
      }
    }
    return { ok: true, obs: null, exhausted: Boolean(air.exhausted), retryAfterMs: 0 }
  }
  const obs = withSlot(normalized, slot)
  if (options.cache && slot) await options.cache.set(point.key, slot, obs)
  return {
    ok: true,
    obs,
    exhausted: Boolean(air.exhausted),
    retryAfterMs: air.retry ? air.retryAfterMs || 1000 : 0,
  }
}

/** One coordinate. Null when the point is invalid or the provider did not answer. */
export async function fetchObservation(lat, lng, options = {}) {
  const key = gridKey(lat, lng)
  if (!key) return null
  const [la, ln] = key.split(',').map(Number)
  const result = await requestPoint({ key, lat: la, lng: ln }, options)
  return result.ok ? result.obs : null
}

/**
 * Readings for every point that succeeded. Failures are listed so the caller
 * can try them on a later pass instead of describing them as clear.
 * `until` stops this invocation before the function timeout.
 */
export async function fetchGrids(points, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = options.now || (() => Date.now())
  const onProgress = options.onProgress || (async () => {})
  const until = options.until ?? now() + 8 * 60 * 1000
  const observations = new Map()
  const failed = []
  const queue = [...(points || [])]
  let coolOffUntil = 0
  let exhausted = false

  async function one(point) {
    if (exhausted || now() >= until) {
      failed.push(point.key)
      return
    }
    let attempt = 0
    while (attempt < MAX_ATTEMPTS) {
      const wait = Math.max(0, coolOffUntil - now())
      if (wait > 0) await sleep(Math.min(wait, BACKOFF_CAP_MS))
      // Another worker may have hit the daily limit while this one slept.
      if (exhausted || now() >= until) {
        failed.push(point.key)
        return
      }
      const result = await requestPoint(point, {
        fetchImpl,
        now: now(),
        cache: options.cache,
        slot: options.slot,
      })
      await onProgress()
      // The rest of this pass would get the same answer. They stay listed as
      // failed, not clear, and a tick after 00:00 UTC asks again. A reading
      // that came back with only the air-quality request refused is kept:
      // the weather half is real.
      if (result.exhausted) exhausted = true
      if (result.retryAfterMs) {
        coolOffUntil = Math.max(coolOffUntil, now() + Math.min(result.retryAfterMs, BACKOFF_CAP_MS))
      }
      if (result.ok) {
        if (result.obs) observations.set(point.key, result.obs)
        else failed.push(point.key)
        return
      }
      if (exhausted || !result.retry) break
      attempt += 1
      if (attempt < MAX_ATTEMPTS && !result.retryAfterMs) {
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000))
      }
    }
    failed.push(point.key)
  }

  async function worker() {
    while (queue.length) {
      const point = queue.shift()
      if (point?.key) await one(point)
    }
  }

  const workers = Math.min(FETCH_CONCURRENCY, queue.length)
  if (workers) await Promise.all(Array.from({ length: workers }, () => worker()))
  return { observations, failed, exhausted }
}
