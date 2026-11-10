// ─────────────────────────────────────────────────────────────────────────────
// The GitHub Pages demo.
//
// A demo build (VITE_DEMO=1, see .github/workflows/pages-demo.yml) has no
// server. The data lives in the browser through the memory driver
// (VITE_DATA_DRIVER=memory), uploaded files through the demo storage driver,
// and the handful of server endpoints the app calls — sign-in, password
// reset, the /rpc jobs — are answered here, in the page, by intercepting
// fetch to the demo gateway.
//
// None of this is security: there is no server and no access rule; every
// visitor can see and change everything in their own tab. That is fine for
// a demo whose data is invented and lives only in the visitor's browser, and
// it is why a demo build must never be pointed at real records.
// ─────────────────────────────────────────────────────────────────────────────
import { runtimeEnv } from '../shared/runtimeConfig'

// Written without ?. so Vite replaces it at build time: a normal build then
// drops every demo branch, and the demo accounts never ship to production.
export const DEMO = import.meta.env.VITE_DEMO === '1'

// Invented people. The passwords are printed on the sign-in page on purpose.
export const DEMO_ACCOUNTS = [
  { uid: 'demo-admin', email: 'admin@demo.test', password: 'demo-admin', name: 'Alex Admin', role: 'admin' },
  { uid: 'demo-manager', email: 'manager@demo.test', password: 'demo-manager', name: 'Morgan Manager', role: 'manager' },
  { uid: 'demo-employee', email: 'employee@demo.test', password: 'demo-employee', name: 'Eli Employee', role: 'member' },
]

const b64url = (obj) =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A token sessionUid() can read. Unsigned: there is no server to check it. */
export function demoToken(uid, now = Date.now()) {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: uid, exp: Math.floor(now / 1000) + 8 * 3600 })}.demo`
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function bodyOf(init) {
  try {
    return JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
  } catch {
    return {}
  }
}

/**
 * Answer one request to the demo gateway, or return null if it is not one.
 * `createUser` writes a profile for the Employees page's Add employee.
 */
export async function demoResponse(url, init, { createUser } = {}) {
  const gateway = runtimeEnv('DATA_GATEWAY').replace(/\/$/, '')
  if (!gateway || !String(url).startsWith(gateway)) return null
  const path = String(url).slice(gateway.length).split('?')[0]
  const body = await bodyOf(init)

  if (path === '/auth/password') {
    const email = String(body.email || '').trim().toLowerCase()
    const who = DEMO_ACCOUNTS.find((a) => a.email === email && a.password === body.password)
    if (!who) {
      return json(401, {
        code: 'unauthenticated',
        reason: 'credentials',
        message: 'Use one of the demo accounts listed on this page.',
      })
    }
    return json(200, { token: demoToken(who.uid) })
  }
  if (path === '/auth/forgot' || path === '/auth/reset') {
    return json(200, { ok: true, message: 'The demo sends no email. Use one of the demo accounts.' })
  }
  if (path.startsWith('/rpc/')) {
    const name = path.slice('/rpc/'.length)
    if (name === 'getDataKeys') return json(200, {})
    if (['stampIdentity', 'completePasswordChange', 'resetMemberPassword', 'deleteOrgFile'].includes(name)) {
      return json(200, { ok: true })
    }
    if (name === 'createMember' && createUser) {
      const uid = `demo-${Math.random().toString(36).slice(2, 10)}`
      await createUser(uid, body)
      return json(200, { ok: true, uid, email: body.email, role: body.role })
    }
    return json(503, { code: 'unavailable', message: 'This needs the real server; it is not part of the demo.' })
  }
  return json(404, { code: 'not-found', message: 'not in the demo' })
}

/** Route fetch calls for the demo gateway to demoResponse; everything else is untouched. */
export function installDemoFetch(options) {
  const real = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input)
    const answered = await demoResponse(url, init, options)
    return answered || real(input, init)
  }
}
