import { publicPath } from '../publicPath'
// Optional iOS store listings. Environment values override public/store.json.
// Accept only HTTPS URLs on the official Apple hosts.
const APPLE_HOST = 'apps.apple.com'
const TESTFLIGHT_HOST = 'testflight.apple.com'

export function storeUrl(raw, host) {
  const value = String(raw ?? '').trim()
  if (!value) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (url.hostname !== host) return null
  return url.toString()
}

function pick(envValue, configValue) {
  const fromEnv = String(envValue ?? '').trim()
  if (fromEnv) return fromEnv
  return String(configValue ?? '').trim()
}

export function resolveStoreLinks({ env = {}, config = {} } = {}) {
  return {
    appStore: storeUrl(pick(env.VITE_APP_STORE_URL, config.appStoreUrl), APPLE_HOST),
    testFlight: storeUrl(pick(env.VITE_TESTFLIGHT_URL, config.testFlightUrl), TESTFLIGHT_HOST),
  }
}

export async function loadPublicStoreConfig(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(publicPath('/store.json'))
    if (!res?.ok) return {}
    const data = await res.json()
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    return {
      appStoreUrl: data.appStoreUrl,
      testFlightUrl: data.testFlightUrl,
    }
  } catch {
    return {}
  }
}
