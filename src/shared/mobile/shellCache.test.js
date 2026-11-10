import { describe, expect, it } from 'vitest'
import { shellCacheDecision } from './shellCache'

const ORIGIN = 'https://suite.weehs.org'

describe('shellCacheDecision', () => {
  // A stored file or a record cached here would be handed to the next person
  // on a shared phone, and a file would outlive its expiring download link.
  it('never stores the server: files, records, jobs, sign-in, health', () => {
    for (const path of [
      '/blob?op=get&path=files%2Fincident-photos%2Fa.jpg&exp=1&sig=s',
      '/data',
      '/presign',
      '/health',
      '/rpc/getDataKeys',
      '/auth/password',
    ]) {
      expect(shellCacheDecision(`${ORIGIN}${path}`, { origin: ORIGIN }), path).toBe('pass')
    }
  })

  it('does not touch requests to other hosts', () => {
    const urls = [
      'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k',
      'https://securetoken.googleapis.com/v1/token?key=k',
      'https://firestore.googleapis.com/v1/projects/weehs-4eb28/databases/(default)/documents/qr/tok',
      'https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo',
      'https://firebasestorage.googleapis.com/v0/b/bucket/o/photo',
      'https://content-firebaseappcheck.googleapis.com/v1/projects/x',
      'https://www.google.com/recaptcha/api.js',
      'https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js',
    ]
    for (const url of urls) {
      expect(shellCacheDecision(url, { origin: ORIGIN })).toBe('pass')
    }
  })

  it('does not touch a non-GET, even on our own origin', () => {
    expect(shellCacheDecision(`${ORIGIN}/field/scan`, { method: 'POST', origin: ORIGIN })).toBe(
      'pass'
    )
  })

  it('does not cache the auth handler, the health probe, or the store listings', () => {
    expect(shellCacheDecision(`${ORIGIN}/__/auth/handler`, { origin: ORIGIN })).toBe('pass')
    expect(shellCacheDecision(`${ORIGIN}/health.json`, { origin: ORIGIN })).toBe('pass')
    expect(shellCacheDecision(`${ORIGIN}/runtime-config.js`, { origin: ORIGIN })).toBe('pass')
    expect(shellCacheDecision(`${ORIGIN}/store.json`, { origin: ORIGIN })).toBe('pass')
    expect(shellCacheDecision(`${ORIGIN}/downloads/weehs-ohsms.apk`, { origin: ORIGIN })).toBe(
      'pass'
    )
    expect(shellCacheDecision(`${ORIGIN}/downloads/weehs-ohsms.json`, { origin: ORIGIN })).toBe(
      'pass'
    )
    expect(shellCacheDecision(`${ORIGIN}/privacy`, { origin: ORIGIN })).toBe('pass')
    expect(shellCacheDecision(`${ORIGIN}/privacy.html`, { origin: ORIGIN })).toBe('pass')
    expect(shellCacheDecision(`${ORIGIN}/terms`, { origin: ORIGIN })).toBe('pass')
    expect(shellCacheDecision(`${ORIGIN}/terms.html`, { origin: ORIGIN })).toBe('pass')
  })

  it('keeps hashed assets and the manifest', () => {
    expect(shellCacheDecision(`${ORIGIN}/assets/index-abc123.js`, { origin: ORIGIN })).toBe('asset')
    expect(shellCacheDecision(`${ORIGIN}/assets/index-abc123.css`, { origin: ORIGIN })).toBe(
      'asset'
    )
    expect(shellCacheDecision(`${ORIGIN}/icons/icon-192.png`, { origin: ORIGIN })).toBe('asset')
    expect(shellCacheDecision(`${ORIGIN}/manifest.webmanifest`, { origin: ORIGIN })).toBe('asset')
  })

  it('treats app routes as navigations, including a scanned asset', () => {
    expect(shellCacheDecision(`${ORIGIN}/field/scan`, { origin: ORIGIN })).toBe('navigate')
    expect(shellCacheDecision(`${ORIGIN}/field/asset/tok`, { origin: ORIGIN })).toBe('navigate')
    expect(shellCacheDecision(`${ORIGIN}/portal`, { origin: ORIGIN })).toBe('navigate')
    expect(shellCacheDecision(`${ORIGIN}/index.html`, { origin: ORIGIN })).toBe('navigate')
  })
})
