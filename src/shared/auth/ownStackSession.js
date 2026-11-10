// The own-stack session the browser may hold.
//
// It proves who signed in (the uid). It does not prove role, approval, or
// mustChangePassword: those are read from the profile at the gateway, because
// a claim baked into the token would stay true for the life of the token
// after the person was suspended (S-19). The token is not a
// database password and it is not a VITE_ variable.

import { runtimeEnv } from '../runtimeConfig'

export function isOwnStackBuild() {
  const driver = runtimeEnv('DATA_DRIVER')
  return (
    String(driver || '')
      .trim()
      .toLowerCase() === 'postgres'
  )
}

export function ownStackGateway() {
  const raw = runtimeEnv('DATA_GATEWAY')
  return String(raw || '').replace(/\/$/, '')
}

export function ownStackAuthMethod() {
  const raw = runtimeEnv('AUTH_METHOD')
  return String(raw || '')
    .trim()
    .toLowerCase()
}

const KEY = 'ohsms.ownStack.session'
let memory = ''

export function setAccessToken(token) {
  memory = typeof token === 'string' ? token : ''
  try {
    if (memory) sessionStorage.setItem(KEY, memory)
    else sessionStorage.removeItem(KEY)
  } catch {
    // Private mode and the test runner have no storage. The memory copy is
    // the session for this tab either way.
  }
}

export function currentAccessToken() {
  if (memory) return memory
  try {
    memory = sessionStorage.getItem(KEY) || ''
  } catch {
    memory = ''
  }
  return memory
}

export function clearAccessToken() {
  setAccessToken('')
}

/**
 * Take the session the host's sign-in redirect put in the URL fragment
 * (`/#session=<token>`), store it, and strip it from the address bar.
 *
 * This has to run before the router does anything. It used to run in
 * AuthProvider's effect, but effects run child-first, so the `/` route's
 * `<Navigate to="/portal">` replaced the URL — fragment and all — before the
 * provider looked. Every SAML and OIDC sign-in on a dedicated build landed
 * back on /login with a valid session thrown away.
 *
 * @returns {boolean} whether a session was taken
 */
export function adoptSessionFromHash(loc = typeof window !== 'undefined' ? window.location : null) {
  if (!loc || !String(loc.hash || '').includes('session=')) return false
  const token = new URLSearchParams(String(loc.hash).replace(/^#/, '')).get('session')
  if (token) setAccessToken(token)
  // The token must not stay in history, where a back button or a shared
  // screenshot would carry it.
  window.history.replaceState({}, '', loc.pathname + loc.search)
  return Boolean(token)
}

function decodeBase64Url(part) {
  const pad = part.replace(/-/g, '+').replace(/_/g, '/')
  const padded = pad + '='.repeat((4 - (pad.length % 4)) % 4)
  if (typeof atob === 'function') return atob(padded)
  return Buffer.from(padded, 'base64').toString('utf8')
}

/** uid from the token payload. Unverified: the gateway checks the signature. */
export function sessionUid(token = currentAccessToken()) {
  const part = String(token || '').split('.')[1]
  if (!part) return ''
  try {
    const json = JSON.parse(decodeBase64Url(part))
    return typeof json.sub === 'string' ? json.sub : ''
  } catch {
    return ''
  }
}
