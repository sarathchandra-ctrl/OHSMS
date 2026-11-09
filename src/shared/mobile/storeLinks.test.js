import { describe, expect, it } from 'vitest'
import { loadPublicStoreConfig, resolveStoreLinks, storeUrl } from './storeLinks'

const APPLE = 'https://apps.apple.com/app/weehs-ohsms/id0000000000'

describe('storeUrl', () => {
  it('accepts only https on the real store host', () => {
    expect(storeUrl(APPLE, 'apps.apple.com')).toBe(APPLE)
    expect(storeUrl('', 'apps.apple.com')).toBeNull()
    expect(storeUrl('   ', 'apps.apple.com')).toBeNull()
    expect(storeUrl('not a url', 'apps.apple.com')).toBeNull()
    expect(storeUrl('http://apps.apple.com/store/apps/details?id=x', 'apps.apple.com')).toBeNull()
    expect(storeUrl('javascript:alert(1)', 'apps.apple.com')).toBeNull()
    expect(storeUrl('https://evil.com/store/apps/details?id=x', 'apps.apple.com')).toBeNull()
    expect(storeUrl('https://apps.apple.com.evil.com/store', 'apps.apple.com')).toBeNull()
    expect(storeUrl('https://user:pass@apps.apple.com/store/apps', 'apps.apple.com')).toBeNull()
  })
})

describe('resolveStoreLinks', () => {
  it('is empty when neither source has a listing', () => {
    expect(resolveStoreLinks()).toEqual({ appStore: null, testFlight: null })
    expect(resolveStoreLinks({ config: { appStoreUrl: '' } })).toEqual({
      appStore: null,
      testFlight: null,
    })
  })

  it('uses the public config when the env vars are unset', () => {
    expect(
      resolveStoreLinks({
        config: {
          appStoreUrl: APPLE,
          testFlightUrl: 'https://testflight.apple.com/join/abc',
        },
      })
    ).toEqual({
      appStore: APPLE,
      testFlight: 'https://testflight.apple.com/join/abc',
    })
  })

  it('rejects a TestFlight link that is not testflight.apple.com', () => {
    expect(
      resolveStoreLinks({ config: { testFlightUrl: 'https://evil.example/join/abc' } }).testFlight
    ).toBeNull()
  })

  it('lets an env value win, and does not fall through when that value is unusable', () => {
    expect(
      resolveStoreLinks({
        env: { VITE_APP_STORE_URL: APPLE },
        config: { appStoreUrl: 'https://apps.apple.com/app/other/id1' },
      }).appStore
    ).toBe(APPLE)
    expect(
      resolveStoreLinks({
        env: { VITE_APP_STORE_URL: 'https://evil.example/app' },
        config: { appStoreUrl: APPLE },
      }).appStore
    ).toBeNull()
  })
})

describe('loadPublicStoreConfig', () => {
  it('reads the two fields and treats a failed fetch as no listing', async () => {
    const ok = await loadPublicStoreConfig(async () => ({
      ok: true,
      json: async () => ({ appStoreUrl: APPLE, extra: true }),
    }))
    expect(ok).toEqual({ appStoreUrl: APPLE, testFlightUrl: undefined })
    expect(await loadPublicStoreConfig(async () => ({ ok: false }))).toEqual({})
    expect(
      await loadPublicStoreConfig(async () => {
        throw new Error('offline')
      })
    ).toEqual({})
    expect(
      await loadPublicStoreConfig(async () => ({ ok: true, json: async () => ['nope'] }))
    ).toEqual({})
  })
})
