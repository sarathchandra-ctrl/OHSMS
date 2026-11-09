// ─────────────────────────────────────────────────────────────────────────────
// Connectivity self-diagnostic. A network error here almost always means the
// browser/device cannot reach the organization's server — something on the
// user's side silently intercepting the connection (a VPN with a broken
// tunnel, antivirus "HTTPS/SSL scanning", an ad/privacy extension, or a
// network firewall/proxy). These checks reach the real server and classify the
// failure so we can tell the user what's wrong instead of a vague "check your
// connection".
// ─────────────────────────────────────────────────────────────────────────────

import { ownStackGateway } from '../../../shared/auth/ownStackSession'

// Fetch a URL with a hard timeout. We distinguish three outcomes:
//  - reachable: we got ANY HTTP response (even 400/401/403) → the path works.
//  - timeout:   the request hung past the deadline → a VPN / antivirus / firewall
//               is swallowing the connection (the classic "pending forever").
//  - blocked:   fetch threw quickly (TypeError) → an extension / ad-blocker
//               killed it, or DNS failed.
async function probe(url, init, timeoutMs = 8000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const start = (performance?.now?.() ?? 0)
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal })
    return { state: 'reachable', status: r.status, ms: Math.round((performance?.now?.() ?? 0) - start) }
  } catch (e) {
    const ms = Math.round((performance?.now?.() ?? 0) - start)
    if (e?.name === 'AbortError') return { state: 'timeout', ms }
    return { state: 'blocked', detail: e?.message || String(e), ms }
  } finally {
    clearTimeout(timer)
  }
}

function storageCheck() {
  const out = { sessionStorage: false, indexedDB: false, detail: '' }
  try {
    const k = '__ira_probe__'
    window.sessionStorage.setItem(k, '1')
    window.sessionStorage.removeItem(k)
    out.sessionStorage = true
  } catch (e) { out.detail = 'sessionStorage blocked' }
  try {
    out.indexedDB = typeof window.indexedDB !== 'undefined' && window.indexedDB !== null
  } catch (e) { out.detail += (out.detail ? '; ' : '') + 'indexedDB blocked' }
  return out
}

// Map a probe result to a user-facing check row.
function classify(name, res, { reachableHint, timeoutHint, blockedHint } = {}) {
  if (res.state === 'reachable') {
    return { name, ok: true, label: `Reachable (HTTP ${res.status}, ${res.ms} ms)`, hint: reachableHint || '' }
  }
  if (res.state === 'timeout') {
    return { name, ok: false, kind: 'timeout', label: `No response — the connection hung (timed out after ${res.ms} ms)`, hint: timeoutHint }
  }
  return { name, ok: false, kind: 'blocked', label: `Request was blocked (${res.detail})`, hint: blockedHint }
}

/**
 * Run all connectivity checks. Returns { checks: [...], verdict, advice }.
 * Each check: { name, ok, kind?, label, hint }.
 */
export async function runConnectivityChecks() {
  const gateway = ownStackGateway() || (typeof window !== 'undefined' ? window.location.origin : '')
  // 1) This organization's server — sign-in, records and files all go here.
  const auth = await probe(`${gateway}/health`, { method: 'GET', cache: 'no-store' })
  // 2) The same server's data API, which answers even when signed out.
  const firestore = await probe(`${gateway}/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'get', path: 'organization', id: 'profile' }),
  })
  // 3) Plain internet sanity check (another host) — tells us if it's this
  //    server specifically being intercepted vs. the whole connection being down.
  const internet = await probe('https://www.cloudflare.com/favicon.ico', { method: 'GET', mode: 'no-cors' }, 8000)

  const store = storageCheck()

  const VPN_AV_HINT = 'A VPN, antivirus "HTTPS/SSL scanning", or a network firewall is silently swallowing the connection to this site. Fix: disconnect your VPN, turn off antivirus web/HTTPS scanning (or allow this site), or switch network (e.g. a phone hotspot).'
  const BLOCK_HINT = 'A browser extension (ad/privacy blocker) or DNS is blocking this site. Fix: open an Incognito window with extensions disabled, pause your ad-blocker for this site, or switch network.'

  const checks = [
    classify('Organization server', auth, { reachableHint: 'The server is reachable.', timeoutHint: VPN_AV_HINT, blockedHint: BLOCK_HINT }),
    classify('Data service', firestore, { reachableHint: 'Database is reachable.', timeoutHint: VPN_AV_HINT, blockedHint: BLOCK_HINT }),
    {
      name: 'General internet',
      ok: internet.state !== 'timeout', // no-cors returns opaque; treat non-timeout as up
      kind: internet.state === 'timeout' ? 'timeout' : undefined,
      label: internet.state === 'timeout' ? `No response (timed out after ${internet.ms} ms)` : `Reachable (${internet.ms} ms)`,
      hint: internet.state === 'timeout' ? 'Your internet connection itself looks down or fully blocked — check Wi‑Fi/router, then your VPN.' : '',
    },
    {
      name: 'Browser storage (session/IndexedDB)',
      ok: store.sessionStorage && store.indexedDB,
      kind: 'storage',
      label: store.sessionStorage && store.indexedDB ? 'Available' : `Restricted — ${store.detail || 'storage partially blocked'}`,
      hint: store.sessionStorage && store.indexedDB ? '' : 'Your browser is blocking site storage (cookies/site data). Allow cookies & site data for this site, or disable "block all cookies".',
    },
  ]

  const authFailed = !checks[0].ok
  const internetUp = checks[2].ok
  let verdict, advice
  if (!authFailed) {
    verdict = 'ok'
    advice = 'Connection to the server is working. If you still see a "Network error", it was a brief blip — just try signing in again.'
  } else if (internetUp) {
    verdict = checks[0].kind === 'timeout' ? 'intercepted' : 'blocked'
    advice = checks[0].kind === 'timeout' ? VPN_AV_HINT : BLOCK_HINT
  } else {
    verdict = 'offline'
    advice = 'Your internet connection looks down. Check your Wi‑Fi/network (and disconnect any VPN), then try again.'
  }

  return { checks, verdict, advice }
}
