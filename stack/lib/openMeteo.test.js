import { describe, it, expect } from 'vitest'
import {
  gridKey,
  forecastUrl,
  airQualityUrl,
  stepIndex,
  apparentTemperatureC,
  aqiFromParticles,
  normalizeObservation,
  requestPoint,
  fetchGrids,
  HOURLY_WEATHER,
  HOURLY_AIR,
  WEATHER_MODEL,
  FALLBACK_MODEL,
} from './openMeteo.js'

const FORECAST = 'https://api.open-meteo.com/v1/forecast'
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality'
const USER_AGENT = 'OHSMS-weather/1.0 (contact: info@weehs.org)'
const NOW = Date.parse('2026-09-23T06:30:00.000Z')

function response({ status = 200, json = null, retryAfter, body = '' } = {}) {
  return {
    async text() {
      return body
    },
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'retry-after' && retryAfter != null) return String(retryAfter)
        return null
      },
    },
    async json() {
      return json
    },
  }
}

function weatherJson({
  temp = 30,
  rh = 50,
  precip = 0,
  cape = 100,
  code = 0,
  wind = 0,
  ts = [NOW - 3_600_000, NOW - 60_000, NOW + 3_600_000],
  temps,
  precips,
  codes,
  winds,
  rhs,
} = {}) {
  const n = ts.length
  const fill = (v) => Array.from({ length: n }, () => v)
  return {
    hourly: {
      time: ts,
      temperature_2m: temps || fill(temp),
      relative_humidity_2m: rhs || fill(rh),
      precipitation: precips || ts.map((_, i) => (i === 1 ? precip : 0)),
      cape: ts.map((_, i) => (i === 1 ? cape : 0)),
      weather_code: codes || ts.map((_, i) => (i === 1 ? code : 0)),
      wind_speed_10m: winds || fill(wind),
    },
  }
}

function emptyWeatherJson() {
  return {
    hourly: {
      time: [NOW - 60_000],
      temperature_2m: [null],
      relative_humidity_2m: [null],
      precipitation: [null],
      cape: [null],
      weather_code: [null],
      wind_speed_10m: [null],
    },
  }
}

function airJson(aqi = 40, extra = {}) {
  return {
    hourly: {
      time: [NOW - 60_000],
      us_aqi: [aqi],
      ...extra,
    },
  }
}

function modelOf(url) {
  return new URL(url).searchParams.get('models')
}

describe('what leaves for Open-Meteo', () => {
  it('rounds to ~1 km and does not put a key, a site name, visibility or UV on the URL', () => {
    const url = forecastUrl(17.43821, 78.3912, WEATHER_MODEL)
    const parsed = new URL(url)
    expect(`${parsed.origin}${parsed.pathname}`).toBe(FORECAST)
    expect(parsed.searchParams.get('latitude')).toBe('17.44')
    expect(parsed.searchParams.get('longitude')).toBe('78.39')
    expect(parsed.searchParams.get('models')).toBe('icon_global')
    expect(parsed.searchParams.get('hourly')).toBe(HOURLY_WEATHER.join(','))
    expect(parsed.searchParams.get('wind_speed_unit')).toBe('ms')
    expect(parsed.searchParams.get('precipitation_unit')).toBe('mm')
    expect(parsed.searchParams.get('temperature_unit')).toBe('celsius')
    expect(parsed.searchParams.get('timeformat')).toBe('unixtime')
    expect(parsed.searchParams.get('timezone')).toBe('GMT')
    expect(parsed.searchParams.get('past_hours')).toBe('6')
    expect(parsed.searchParams.get('forecast_hours')).toBe('6')
    expect(url).not.toContain('secret-key')
    expect(url).not.toContain('Plant')
    expect(url.toLowerCase()).not.toContain('visibility')
    expect(url.toLowerCase()).not.toContain('uv')
    expect(url).not.toContain('apparent_temperature')
    expect(url).not.toContain('european_aqi')
    expect(url).not.toContain('minutely_15')
    // Two sites a few kilometres apart are two squares, each its own reading.
    expect(gridKey(12.9352, 77.6245)).toBe('12.94,77.62')
    expect(gridKey(12.9116, 77.6389)).toBe('12.91,77.64')
    expect(gridKey(91, 0)).toBe('')
    expect(gridKey(Number.NaN, 0)).toBe('')
    expect(forecastUrl(91, 0, WEATHER_MODEL)).toBe('')

    const air = new URL(airQualityUrl(17.43821, 78.3912))
    expect(`${air.origin}${air.pathname}`).toBe(AIR)
    expect(air.searchParams.get('latitude')).toBe('17.44')
    expect(air.searchParams.get('longitude')).toBe('78.39')
    expect(air.searchParams.get('hourly')).toBe(HOURLY_AIR.join(','))
    expect(air.searchParams.get('models')).toBeNull()
    expect(air.searchParams.get('past_hours')).toBe('6')
    expect(air.searchParams.get('forecast_hours')).toBe('6')
    expect(String(air)).not.toContain('uv')
    expect(String(air)).not.toContain('visibility')
    expect(String(air)).not.toContain('european_aqi')
  })
})

describe('units and feels-like', () => {
  it('computes a feels-like from temperature, humidity and wind, with no radiation term', () => {
    expect(apparentTemperatureC(30, null, 5)).toBe(30)
    expect(apparentTemperatureC(30, 50, 0)).toBeCloseTo(32.98, 1)
    expect(apparentTemperatureC(30, 50, 5)).toBeCloseTo(29.48, 1)
  })

  it('builds an AQI from particles when the index itself is missing', () => {
    expect(aqiFromParticles(12, null)).toBe(50)
    expect(aqiFromParticles(55.5, 10)).toBe(151)
    expect(aqiFromParticles(null, 505)).toBe(401)
    expect(aqiFromParticles(null, null)).toBeNull()
  })
})

describe('normalizeObservation', () => {
  it('reads the step for now, and keeps hourly precipitation as mm/h', () => {
    const obs = normalizeObservation(
      weatherJson({ temp: 30, precip: 12, cape: 1800, code: 0, rh: 50, wind: 0 }),
      airJson(80),
      NOW
    )
    expect(obs.tempC).toBe(30)
    expect(obs.precipMmHr).toBe(12)
    expect(obs.precipMmHr).not.toBe(4)
    expect(obs.capeJkg).toBe(1800)
    expect(obs.lightningCode).toBeNull()
    expect(obs.aqi).toBe(80)
    expect(obs.aqiSource).toBe('aqi')
    expect(obs.apparentTempC).toBeCloseTo(32.98, 1)
    expect(obs.observedAt).toBe(new Date(NOW - 60_000).toISOString())
    expect(obs.visibilityM).toBeUndefined()
    expect(obs.uvIndex).toBeUndefined()
    expect(obs.weatherCode).toBeUndefined()
  })

  it('copies weather codes 95 and 99 onto lightningCode and prefers us_aqi over particles', () => {
    for (const code of [95, 99]) {
      const obs = normalizeObservation(
        weatherJson({ code, cape: 400 }),
        {
          hourly: {
            time: [NOW],
            us_aqi: [30],
            pm2_5: [400],
            pm10: [10],
          },
        },
        NOW
      )
      expect(obs.lightningCode).toBe(code)
      expect(obs.aqi).toBe(30)
      expect(obs.aqiSource).toBe('aqi')
      expect(obs.weatherCode).toBeUndefined()
    }
    expect(normalizeObservation(weatherJson({ code: 96 }), null, NOW).lightningCode).toBe(96)
    expect(normalizeObservation(weatherJson({ code: 80 }), null, NOW).lightningCode).toBeNull()
  })

  it('falls back to particles when us_aqi is absent', () => {
    const obs = normalizeObservation(
      null,
      {
        hourly: {
          time: [NOW],
          us_aqi: [null],
          pm2_5: [55.5],
          pm10: [10],
        },
      },
      NOW
    )
    expect(obs.aqiSource).toBe('pm')
    expect(obs.aqi).toBe(151)
    expect(obs.tempC).toBeNull()
  })

  it('uses the first step when every stamp is still in the future', () => {
    expect(stepIndex([NOW + 1000, NOW + 2000], NOW)).toBe(0)
  })
})

describe('one hour for the whole reading', () => {
  it('does not take a later hour when an earlier hour has temperature', () => {
    const earlier = NOW - 3_600_000
    const obs = normalizeObservation(
      weatherJson({
        ts: [earlier, NOW - 60_000, NOW + 3_600_000],
        temps: [7, null, 40],
        precips: [1, 12, 0],
        codes: [0, 99, 95],
        winds: [0, 0, 0],
        rhs: [50, 50, 50],
      }),
      {
        hourly: {
          time: [earlier, NOW + 3_600_000],
          us_aqi: [40, 180],
        },
      },
      NOW
    )
    expect(obs.tempC).toBe(7)
    expect(obs.precipMmHr).toBe(1)
    expect(obs.lightningCode).toBeNull()
    expect(obs.observedAt).toBe(new Date(earlier).toISOString())
    expect(obs.aqi).toBe(40)
  })
})

describe('fetchGrids', () => {
  const points = [
    { key: '17.44,78.39', lat: 17.438, lng: 78.391, name: 'Plant' },
    { key: '13.08,80.27', lat: 13.08, lng: 80.27 },
  ]

  function scripted(handler) {
    const calls = []
    const fetchImpl = async (url, init) => {
      expect(init.method).toBe('GET')
      expect(init.body).toBeUndefined()
      expect(init.headers['User-Agent']).toBe(USER_AGENT)
      expect(url.startsWith(FORECAST) || url.startsWith(AIR)).toBe(true)
      expect(url).not.toContain('secret-key')
      expect(url).not.toContain('Plant')
      expect(url.toLowerCase()).not.toContain('visibility')
      expect(url.toLowerCase()).not.toContain('uv')
      calls.push(url)
      return handler(url, calls)
    }
    return { calls, fetchImpl }
  }

  it('requests one point at a time on the rounded coordinate', async () => {
    const { calls, fetchImpl } = scripted((url) => {
      if (url.startsWith(AIR)) return response({ json: airJson(42) })
      const lat = Number(new URL(url).searchParams.get('latitude'))
      return response({ json: weatherJson({ temp: lat > 15 ? 30 : 28 }) })
    })
    const { observations, failed } = await fetchGrids(points, {
      apiKey: 'secret-key',
      sleep: async () => {},
      now: () => NOW,
      fetchImpl,
    })
    expect(failed).toEqual([])
    expect(observations.get('17.44,78.39').tempC).toBe(30)
    expect(observations.get('13.08,80.27').aqi).toBe(42)
    expect(calls.some((url) => modelOf(url) === WEATHER_MODEL)).toBe(true)
    expect(calls.some((url) => url.startsWith(AIR))).toBe(true)
    expect(calls.every((url) => !url.includes('gfs_global'))).toBe(true)
    const latitudes = calls
      .filter((url) => url.startsWith(FORECAST))
      .map((url) => new URL(url).searchParams.get('latitude'))
    expect(latitudes.every((lat) => lat === '17.44' || lat === '13.08')).toBe(true)
  })

  it('stops the pass on a spent daily quota instead of retrying every grid', async () => {
    const slept = []
    const { calls, fetchImpl } = scripted(() =>
      response({
        status: 429,
        body: '{"error":true,"reason":"Daily API request limit exceeded. Please try again tomorrow."}',
      })
    )
    const { observations, failed, exhausted } = await fetchGrids(points, {
      sleep: async (ms) => {
        slept.push(ms)
      },
      now: () => NOW,
      fetchImpl,
    })
    expect(exhausted).toBe(true)
    expect(observations.size).toBe(0)
    // Listed as unread, never as clear.
    expect([...failed].sort()).toEqual(points.map((p) => p.key).sort())
    // One ICON ask per worker that started, no GFS, no air, no backoff loop.
    expect(calls.length).toBeLessThanOrEqual(points.length)
    expect(calls.every((url) => modelOf(url) === WEATHER_MODEL)).toBe(true)
    expect(slept).toEqual([])
  })

  it('keeps the weather but stops the pass when only air quality is out of quota', async () => {
    const { calls, fetchImpl } = scripted((url) => {
      if (url.startsWith(AIR)) {
        return response({ status: 429, body: '{"reason":"Daily API request limit exceeded."}' })
      }
      return response({ json: weatherJson({ temp: 33 }) })
    })
    const many = [
      ...points,
      { key: '28.6,77.2', lat: 28.6, lng: 77.2 },
      { key: '19.1,72.9', lat: 19.1, lng: 72.9 },
      { key: '22.6,88.4', lat: 22.6, lng: 88.4 },
      { key: '23.0,72.6', lat: 23.0, lng: 72.6 },
    ]
    const { observations, failed, exhausted } = await fetchGrids(many, {
      sleep: async () => {},
      now: () => NOW,
      fetchImpl,
    })
    expect(exhausted).toBe(true)
    // Each worker's first point still has its weather reading.
    expect(observations.size).toBeGreaterThan(0)
    expect([...observations.values()].every((obs) => obs.tempC === 33)).toBe(true)
    expect(observations.size + failed.length).toBe(many.length)
    expect(failed.length).toBeGreaterThan(0)
    // Nothing is asked after the refusal is seen: at most one ICON and one
    // air request per worker that started.
    expect(calls.length).toBeLessThanOrEqual(2 * 3)
  })

  it('still retries a minutely 429', async () => {
    let iconAttempts = 0
    const { fetchImpl } = scripted((url) => {
      if (modelOf(url) === WEATHER_MODEL) {
        iconAttempts += 1
        if (iconAttempts === 1) {
          return response({
            status: 429,
            body: '{"reason":"Minutely API request limit exceeded."}',
          })
        }
        return response({ json: weatherJson({ temp: 31 }) })
      }
      return response({ json: airJson(10) })
    })
    const { observations, exhausted } = await fetchGrids([points[0]], {
      sleep: async () => {},
      now: () => NOW,
      fetchImpl,
    })
    expect(exhausted).toBe(false)
    expect(observations.get('17.44,78.39').tempC).toBe(31)
  })

  it('retries a 429 and does not open GFS', async () => {
    let iconAttempts = 0
    const slept = []
    const { calls, fetchImpl } = scripted((url) => {
      if (modelOf(url) === WEATHER_MODEL) {
        iconAttempts += 1
        if (iconAttempts === 1) return response({ status: 429, retryAfter: 2 })
        return response({ json: weatherJson({ cape: 2600 }) })
      }
      if (modelOf(url) === FALLBACK_MODEL) return response({ status: 500 })
      return response({ json: airJson(10) })
    })
    const { observations, failed } = await fetchGrids([points[0]], {
      apiKey: 'secret-key',
      sleep: async (ms) => {
        slept.push(ms)
      },
      now: () => NOW,
      fetchImpl,
    })
    expect(failed).toEqual([])
    expect(observations.get('17.44,78.39').capeJkg).toBe(2600)
    expect(calls.filter((url) => modelOf(url) === FALLBACK_MODEL)).toHaveLength(0)
    expect(slept).toContain(2000)
  })

  it('uses GFS when ICON is empty', async () => {
    for (const empty of [
      () => response({ status: 204 }),
      () => response({ json: emptyWeatherJson() }),
    ]) {
      const { calls, fetchImpl } = scripted((url) => {
        if (modelOf(url) === WEATHER_MODEL) return empty()
        if (modelOf(url) === FALLBACK_MODEL) return response({ json: weatherJson({ temp: 40 }) })
        return response({ json: airJson(null) })
      })
      const { observations, failed } = await fetchGrids([points[0]], {
        sleep: async () => {},
        now: () => NOW,
        fetchImpl,
      })
      expect(failed).toEqual([])
      expect(observations.get('17.44,78.39').tempC).toBe(40)
      expect(calls.map((url) => modelOf(url) || 'air')).toEqual([
        WEATHER_MODEL,
        FALLBACK_MODEL,
        'air',
      ])
    }
  })

  it('lists a point that never answers instead of storing it as clear', async () => {
    const { calls, fetchImpl } = scripted((url) => {
      if (modelOf(url) === FALLBACK_MODEL) return response({ json: weatherJson({ temp: 30 }) })
      return response({ status: 503 })
    })
    const { observations, failed } = await fetchGrids([points[0]], {
      sleep: async () => {},
      now: () => NOW,
      fetchImpl,
    })
    expect(observations.size).toBe(0)
    expect(failed).toEqual(['17.44,78.39'])
    expect(calls.filter((url) => modelOf(url) === FALLBACK_MODEL)).toHaveLength(0)
  })

  it('still fetches when no api key is passed', async () => {
    const { calls, fetchImpl } = scripted((url) => {
      if (url.startsWith(AIR)) return response({ json: airJson(42) })
      return response({ json: weatherJson({ temp: 30, precip: 12 }) })
    })
    const { observations, failed } = await fetchGrids(points, {
      sleep: async () => {},
      now: () => NOW,
      fetchImpl,
    })
    expect(calls.length).toBeGreaterThan(0)
    expect(failed).toEqual([])
    expect(observations.get('17.44,78.39').tempC).toBe(30)
    expect(observations.get('17.44,78.39').precipMmHr).toBe(12)
  })

  it('serves the slot cache and does not fetch', async () => {
    let called = false
    const slot = '2026-09-23T06+0530'
    const result = await requestPoint(points[0], {
      apiKey: 'secret-key',
      slot,
      fetchImpl: async () => {
        called = true
        return response({})
      },
      cache: {
        async get() {
          return {
            slot,
            obs: { tempC: 31, observedAt: '2026-09-23T05:30:00.000Z', slot },
          }
        },
        async set() {
          throw new Error('cached')
        },
      },
    })
    expect(called).toBe(false)
    expect(result.obs.tempC).toBe(31)
    expect(result.obs.observedAt).toBe('2026-09-23T05:30:00.000Z')
  })
})
