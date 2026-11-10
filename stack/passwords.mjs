// Email-and-password sign-in, kept by this server.
//
// Passwords are stored only as PBKDF2-SHA256 hashes in auth_secrets, a table
// the data API never reads (stack/engine.mjs only touches `documents`). The
// hash runs through the platform's own WebCrypto so it costs the same on Node
// and on Cloudflare Workers, where a pure-JS hash would run out of CPU time.
// Hashes written by the earlier scrypt code are still accepted.
//
// Every decision re-reads the live profile: a session proves who signed in,
// not that they are still an approved admin.

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'

const WORKER = { role: 'ohsms_worker', uid: '' }

export const MIN_PASSWORD_LENGTH = 10
export const MEMBER_ROLES = ['admin', 'manager', 'member', 'auditor']
const ITERATIONS = 100_000
// Ten wrong passwords for one address lock it for fifteen minutes.
export const MAX_FAILURES = 10
const LOCK_SECONDS = 15 * 60

const EMAIL = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:.]+(?:\.[^\s@<>()"',;:.]+)+$/

export function normalizeEmail(value) {
  if (typeof value !== 'string') return ''
  const email = value.trim().toLowerCase()
  return email.length <= 254 && EMAIL.test(email) ? email : ''
}

function cleanName(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return 'policy'
  if (password.length > 256) return 'policy'
  return ''
}

async function pbkdf2(password, salt, iterations) {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(salt, 'hex'), iterations },
    key,
    256
  )
  return Buffer.from(bits)
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = await pbkdf2(password, salt, ITERATIONS)
  return `pbkdf2-sha256$${ITERATIONS}$${salt}$${hash.toString('hex')}`
}

export async function verifyPassword(stored, password) {
  const parts = String(stored || '').split('$')
  let expected
  let got
  if (parts[0] === 'pbkdf2-sha256' && parts.length === 4) {
    expected = Buffer.from(parts[3], 'hex')
    got = await pbkdf2(String(password), parts[2], Number(parts[1]))
  } else if (parts[0] === 'scrypt' && parts.length === 3) {
    expected = Buffer.from(parts[2], 'hex')
    got = scryptSync(String(password), parts[1], 32)
  } else {
    return false
  }
  return got.length === expected.length && timingSafeEqual(got, expected)
}

// Spent on an unknown address too, so a wrong email and a wrong password
// take the same time.
const DUMMY_HASH = `pbkdf2-sha256$${ITERATIONS}$${'0'.repeat(32)}$${'0'.repeat(64)}`

async function storePassword(db, { uid, email, password }) {
  await db
    .prepare(
      `INSERT INTO auth_secrets (uid, email, password_hash, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (uid) DO UPDATE SET email = excluded.email,
         password_hash = excluded.password_hash, updated_at = excluded.updated_at`
    )
    .bind(uid, email, await hashPassword(password), Date.now())
    .run()
}

async function storedHash(db, uid) {
  const row = await db
    .prepare('SELECT password_hash FROM auth_secrets WHERE uid = ?')
    .bind(uid)
    .first()
  return row?.password_hash || null
}

async function userByEmail(db, email) {
  const row = await db
    .prepare(
      "SELECT id FROM documents WHERE path = 'users' AND lower(json_extract(data, '$.email')) = ? LIMIT 1"
    )
    .bind(email)
    .first()
  return row?.id || null
}

async function liveProfile(engine, uid) {
  if (!uid) return null
  return engine.get(WORKER, 'users', uid)
}

/** The caller, if they are an approved admin who has cleared the password gate. */
export async function liveAdmin(engine, uid) {
  const p = await liveProfile(engine, uid)
  if (!p || p.status !== 'approved' || p.role !== 'admin' || p.mustChangePassword === true) {
    return null
  }
  return p
}

// ── Lockout ─────────────────────────────────────────────────────────────────
// Kept in auth_pending, which the data API never reads.

/** Adds one to a counter that resets after `ttlSeconds`; returns the new count. */
export async function bump(db, key, ttlSeconds) {
  const now = Date.now()
  const row = await db
    .prepare(
      `INSERT INTO auth_pending (key, value, expires_at) VALUES (?, '1', ?)
       ON CONFLICT (key) DO UPDATE SET
         value = CASE WHEN auth_pending.expires_at > ? THEN CAST(auth_pending.value AS INTEGER) + 1 ELSE 1 END,
         expires_at = CASE WHEN auth_pending.expires_at > ? THEN auth_pending.expires_at ELSE excluded.expires_at END
       RETURNING value`
    )
    .bind(key, now + ttlSeconds * 1000, now, now)
    .first()
  return Number(row?.value || 0)
}

async function counter(db, key) {
  const row = await db
    .prepare('SELECT value FROM auth_pending WHERE key = ? AND expires_at > ?')
    .bind(key, Date.now())
    .first()
  return Number(row?.value || 0)
}

// Three counters, each over LOCK_SECONDS. The lockout used to count by
// address alone, which made it a weapon: anyone who knew a colleague's email
// could type ten wrong passwords and keep them out, again and again, from
// anywhere. And nothing limited one source trying a few passwords against
// every address in the organization.
//
//   pwfail:<email>:<ip>   MAX_FAILURES from one source locks that address
//                         for that source only — the stranger locks
//                         themselves out, not the person;
//   pwfailip:<ip>         MAX_FAILURES_PER_SOURCE across all addresses stops
//                         that source entirely (spraying);
//   pwfail:<email>        MAX_FAILURES_PER_ADDRESS from everywhere still
//                         locks the address, so guessing one person's
//                         password from many machines is bounded too — at a
//                         level one person mistyping never reaches.
//
// `ip` is '' when the server cannot tell (the per-source counters then share
// one key, which is the old behaviour).
export const MAX_FAILURES_PER_SOURCE = 50
export const MAX_FAILURES_PER_ADDRESS = 100
const pairKey = (email, ip) => `pwfail:${email}:${ip}`

async function lockReason(db, email, ip) {
  if ((await counter(db, `pwfailip:${ip}`)) >= MAX_FAILURES_PER_SOURCE) return 'throttled'
  if ((await counter(db, pairKey(email, ip))) >= MAX_FAILURES) return 'locked'
  if ((await counter(db, `pwfail:${email}`)) >= MAX_FAILURES_PER_ADDRESS) return 'locked'
  return ''
}

async function recordFailure(db, email, ip) {
  await bump(db, pairKey(email, ip), LOCK_SECONDS)
  await bump(db, `pwfailip:${ip}`, LOCK_SECONDS)
  await bump(db, `pwfail:${email}`, LOCK_SECONDS)
}

async function clearFailures(db, email, ip) {
  await db
    .prepare('DELETE FROM auth_pending WHERE key IN (?, ?)')
    .bind(pairKey(email, ip), `pwfail:${email}`)
    .run()
}

/**
 * @returns {{ ok: true, uid } | { ok: false, reason: 'credentials'|'locked'|'throttled'|'disabled' }}
 */
export async function signInWithPassword(engine, db, { email, password, ip = '' }) {
  const address = normalizeEmail(email)
  if (!address || typeof password !== 'string' || !password) {
    return { ok: false, reason: 'credentials' }
  }
  const source = String(ip || '').slice(0, 64)
  const locked = await lockReason(db, address, source)
  if (locked) return { ok: false, reason: locked }
  const uid = await userByEmail(db, address)
  const hash = uid ? await storedHash(db, uid) : null
  const matches = await verifyPassword(hash || DUMMY_HASH, password)
  if (!uid || !hash || !matches) {
    await recordFailure(db, address, source)
    return { ok: false, reason: 'credentials' }
  }
  const profile = await liveProfile(engine, uid)
  // Suspended or disabled people do not get a session at all.
  if (!profile || !['approved', 'pending'].includes(profile.status)) {
    return { ok: false, reason: 'disabled' }
  }
  await clearFailures(db, address, source)
  return { ok: true, uid }
}

/** An admin adds a person, with a temporary password they must replace. */
export async function createMember(engine, db, { uid, email, name, role, password }) {
  const admin = await liveAdmin(engine, uid)
  if (!admin) return { ok: false, reason: 'not-admin' }
  const address = normalizeEmail(email)
  if (!address) return { ok: false, reason: 'email' }
  if (!MEMBER_ROLES.includes(role)) return { ok: false, reason: 'role' }
  if (passwordProblem(password)) return { ok: false, reason: 'policy' }
  if (await userByEmail(db, address)) return { ok: false, reason: 'already-member' }
  const id = randomUUID()
  await engine.commit(WORKER, [
    {
      type: 'set',
      path: 'users',
      id,
      merge: false,
      data: {
        name: cleanName(name) || address,
        email: address,
        role,
        status: 'approved',
        mustChangePassword: true,
        dept: '',
        department: '',
        access: { sites: [], regions: [], entities: [] },
        createdBy: uid,
        createdAt: { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 },
      },
    },
  ])
  await storePassword(db, { uid: id, email: address, password })
  return { ok: true, uid: id, email: address, role }
}

/** An admin sets a new temporary password for someone who forgot theirs. */
export async function resetMemberPassword(engine, db, { uid, targetUid, password }) {
  const admin = await liveAdmin(engine, uid)
  if (!admin) return { ok: false, reason: 'not-admin' }
  if (passwordProblem(password)) return { ok: false, reason: 'policy' }
  const target = await liveProfile(engine, targetUid)
  if (!target?.email) return { ok: false, reason: 'no-user' }
  await storePassword(db, { uid: targetUid, email: target.email, password })
  await engine.commit(WORKER, [
    { type: 'update', path: 'users', id: targetUid, data: { mustChangePassword: true } },
  ])
  await clearFailures(db, normalizeEmail(target.email))
  return { ok: true }
}

/** The signed-in person replaces their own password. */
export async function changeOwnPassword(
  engine,
  db,
  { uid, authTime, current, password, now = Date.now() }
) {
  if (!uid) return { ok: false, reason: 'unauthenticated' }
  // Within ten minutes of signing in, so a session left open on a shared
  // machine cannot be used to take the account over.
  if (typeof authTime === 'number' && now - authTime * 1000 > 10 * 60 * 1000) {
    return { ok: false, reason: 'stale' }
  }
  const profile = await liveProfile(engine, uid)
  if (!profile?.email) return { ok: false, reason: 'no-profile' }
  const hash = await storedHash(db, uid)
  if (!hash || !(await verifyPassword(hash, String(current || '')))) {
    return { ok: false, reason: 'current-rejected' }
  }
  if (passwordProblem(password) || password === current) return { ok: false, reason: 'policy' }
  await storePassword(db, { uid, email: profile.email, password })
  if (profile.mustChangePassword === true) {
    await engine.commit(WORKER, [
      { type: 'update', path: 'users', id: uid, data: { mustChangePassword: false } },
    ])
  }
  return { ok: true }
}

/**
 * First start: the organization and its first administrator. Idempotent —
 * it creates nothing once an organization and an admin exist, so changing
 * the settings later never overwrites anyone's password.
 */
export async function bootstrapOrganization(
  engine,
  db,
  // mustChange: false when the operator chose ADMIN_PASSWORD themselves
  // (ADMIN_MUST_CHANGE=false); a generated one must be replaced at first sign-in.
  { orgName, adminEmail, adminPassword, adminName = '', mustChange = true }
) {
  const org = await engine.get(WORKER, 'organization', 'profile')
  if (!org) {
    await engine.commit(WORKER, [
      {
        type: 'set',
        path: 'organization',
        id: 'profile',
        merge: false,
        data: { name: cleanName(orgName) || 'Cult Fit', address: '', createdBy: 'bootstrap' },
      },
    ])
  }
  const admins = await db
    .prepare(
      "SELECT 1 AS one FROM documents WHERE path = 'users' AND json_extract(data, '$.role') = 'admin' LIMIT 1"
    )
    .first()
  if (admins) return { created: false }
  const address = normalizeEmail(adminEmail)
  if (!address || passwordProblem(adminPassword)) return { created: false, reason: 'settings' }
  const id = randomUUID()
  await engine.commit(WORKER, [
    {
      type: 'set',
      path: 'users',
      id,
      merge: false,
      data: {
        name: cleanName(adminName) || address,
        email: address,
        role: 'admin',
        status: 'approved',
        mustChangePassword: mustChange !== false,
        dept: '',
        department: '',
        access: { sites: [], regions: [], entities: [] },
        createdBy: 'bootstrap',
      },
    },
  ])
  await storePassword(db, { uid: id, email: address, password: adminPassword })
  return { created: true, uid: id }
}

// ── Reset by email ──────────────────────────────────────────────────────────
// A one-time link, valid for 30 minutes. Only the SHA-256 of the token is
// stored (auth_pending, which the data API cannot read), so a database dump
// cannot be turned into working links. Using a link consumes it.

const RESET_TTL_SECONDS = 30 * 60
// At most three links per address per hour: the request is unauthenticated,
// and each one sends a mail.
const RESET_PER_HOUR = 3
// Per source, across addresses: the per-address cap alone let one machine
// walk the staff list and send every person three mails an hour from the
// organization's domain, on its mail bill.
export const RESETS_PER_SOURCE_HOUR = 20

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

/**
 * Starts a reset. Always resolves `{ ok: true }`, whether or not the address
 * has an account, so the answer tells nobody who works here. `send` is
 * `({ to, subject, text }) => { sent }`; the link is built on `origin`.
 */
export async function requestPasswordReset(
  engine,
  db,
  { email, origin, send, appName = 'Cult Fit SMS', ip = '' }
) {
  const address = normalizeEmail(email)
  if (!address || typeof send !== 'function') return { ok: true }
  const source = String(ip || '').slice(0, 64)
  if ((await bump(db, `pwresetip:${source}`, 60 * 60)) > RESETS_PER_SOURCE_HOUR) return { ok: true }
  if ((await bump(db, `pwresetcount:${address}`, 60 * 60)) > RESET_PER_HOUR) return { ok: true }

  const uid = await userByEmail(db, address)
  const profile = uid ? await liveProfile(engine, uid) : null
  if (!profile || !['approved', 'pending'].includes(profile.status)) return { ok: true }

  const token = randomBytes(32).toString('base64url')
  await db
    .prepare('INSERT INTO auth_pending (key, value, expires_at) VALUES (?, ?, ?)')
    .bind(
      `pwreset:${sha256(token)}`,
      JSON.stringify({ uid, email: address }),
      Date.now() + RESET_TTL_SECONDS * 1000
    )
    .run()
  // In the fragment, not the query: a fragment is never sent to a server, so
  // the token stays out of access logs and Referer headers.
  const link = `${String(origin).replace(/\/$/, '')}/reset-password#token=${token}`
  await send({
    to: address,
    subject: `Reset your ${appName} password`,
    text:
      `Someone asked to reset the password for ${address} on ${appName}.\n\n` +
      `Choose a new password here (the link works once, for 30 minutes):\n${link}\n\n` +
      `If this was not you, ignore this email: your password has not changed.`,
  })
  return { ok: true }
}

/** Completes a reset with the token from the emailed link. */
export async function completePasswordReset(engine, db, { token, password }) {
  if (typeof token !== 'string' || token.length < 20) return { ok: false, reason: 'link' }
  if (passwordProblem(password)) return { ok: false, reason: 'policy' }
  // Delete-and-return in one statement: the same link cannot be used twice,
  // even by two requests at once.
  const row = await db
    .prepare('DELETE FROM auth_pending WHERE key = ? AND expires_at > ? RETURNING value')
    .bind(`pwreset:${sha256(token)}`, Date.now())
    .first()
  const claim = row?.value ? JSON.parse(row.value) : null
  if (!claim?.uid) return { ok: false, reason: 'link' }
  const profile = await liveProfile(engine, claim.uid)
  if (!profile || !['approved', 'pending'].includes(profile.status)) {
    return { ok: false, reason: 'link' }
  }
  await storePassword(db, { uid: claim.uid, email: profile.email || claim.email, password })
  if (profile.mustChangePassword === true) {
    await engine.commit(WORKER, [
      { type: 'update', path: 'users', id: claim.uid, data: { mustChangePassword: false } },
    ])
  }
  await clearFailures(db, normalizeEmail(profile.email || claim.email))
  return { ok: true }
}
