import { describe, expect, it } from 'vitest'
import { profileReachesSite, serveSiteWeather, weatherBucket } from './siteWeather.js'

const NOW = Date.parse('2026-09-23T06:30:00.000Z')
const SITES = [
  { id: 's1', name: 'Depot', region: 'North', entity: 'E1', lat: 19.0812, lng: 72.8812 },
  { id: 's2', name: 'Plant', region: 'South', entity: 'E2', lat: 12.97, lng: 77.59 },
]
const employee = { role: 'member', status: 'approved', access: { sites: ['s1'] } }

// A provider that answers like Open-Meteo, and records that it was asked.
function provider() {
  const calls = []
  const ok = (json) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => json, text: async () => '' })
  const fetchImpl = async (url) => {
    calls.push(String(url))
    const ts = [NOW - 3_600_000, NOW - 60_000, NOW + 3_600_000]
    if (String(url).includes('air-quality')) return ok({ hourly: { time: [NOW - 60_000], us_aqi: [40] } })
    const fill = (v) => ts.map(() => v)
    return ok({
      hourly: {
        time: ts,
        temperature_2m: fill(31),
        relative_humidity_2m: fill(50),
        precipitation: fill(0),
        cape: fill(0),
        weather_code: fill(0),
        wind_speed_10m: fill(1),
      },
    })
  }
  return { calls, fetchImpl }
}

function memoryCache() {
  const docs = new Map()
  return { docs, get: async (k) => docs.get(k) || null, set: async (k, slot, obs) => docs.set(k, { slot, obs }) }
}

describe('fetchSiteWeather on the server', () => {
  it('answers for a site the caller can see, and caches the reading for the slot', async () => {
    const { calls, fetchImpl } = provider()
    const cache = memoryCache()
    const ask = () =>
      serveSiteWeather({ profile: employee, data: { lat: 19.0812, lng: 72.8812 }, sites: SITES, cache, fetchImpl, nowMs: NOW })
    const first = await ask()
    expect(first.body.obs.tempC).toBe(31)
    const fetched = calls.length
    const second = await ask()
    expect(second.body.obs.tempC).toBe(31)
    expect(calls.length).toBe(fetched)
  })

  // The server is not an open weather proxy: only coordinates of sites the
  // caller already sees, only for approved accounts past the temporary password.
  it('refuses a coordinate that is not one of the caller\'s sites', async () => {
    const { calls, fetchImpl } = provider()
    const outside = await serveSiteWeather({ profile: employee, data: { lat: 12.97, lng: 77.59 }, sites: SITES, fetchImpl, nowMs: NOW })
    const nowhere = await serveSiteWeather({ profile: employee, data: { lat: 51.5, lng: -0.12 }, sites: SITES, fetchImpl, nowMs: NOW })
    expect(outside.error).toBe('permission-denied')
    expect(nowhere.error).toBe('permission-denied')
    expect(calls).toEqual([])
  })

  it('refuses pending, suspended and temporary-password accounts', async () => {
    const { fetchImpl } = provider()
    for (const profile of [
      null,
      { ...employee, status: 'pending' },
      { ...employee, status: 'suspended' },
      { ...employee, mustChangePassword: true },
    ]) {
      const r = await serveSiteWeather({ profile, data: { lat: 19.0812, lng: 72.8812 }, sites: SITES, fetchImpl, nowMs: NOW })
      expect(r.error).toBe('permission-denied')
    }
  })

  it('stops fetching when the caller is over the rate limit', async () => {
    const { calls, fetchImpl } = provider()
    const r = await serveSiteWeather({
      profile: employee,
      data: { lat: 19.0812, lng: 72.8812 },
      sites: SITES,
      fetchImpl,
      takeRate: async () => false,
      nowMs: NOW,
    })
    expect(r.body).toEqual({ obs: null, limited: true })
    expect(calls).toEqual([])
  })
})

describe('profileReachesSite / weatherBucket', () => {
  it('matches the app: admin, posting, site, region or entity grant', () => {
    expect(profileReachesSite({ role: 'admin' }, SITES[1])).toBe(true)
    expect(profileReachesSite({ role: 'member', siteId: 's2' }, SITES[1])).toBe(true)
    expect(profileReachesSite({ role: 'manager', access: { regions: ['South'] } }, SITES[1])).toBe(true)
    expect(profileReachesSite({ role: 'member', access: { entities: ['E2'] } }, SITES[1])).toBe(true)
    expect(profileReachesSite({ role: 'member', access: { regions: ['North'] } }, SITES[1])).toBe(false)
  })

  it('names the six-hour Kolkata slot', () => {
    expect(weatherBucket(new Date(NOW))).toBe('2026-09-23T12+0530')
  })
})
