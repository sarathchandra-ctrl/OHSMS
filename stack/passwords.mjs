// Email-and-password sign-in, kept by this server.
//
// Passwords are stored only as PBKDF2-SHA256 hashes in auth_secrets, a table
// the data API cannot reach (no grant to the browser role, RLS forced). The
// hash runs through the platform's own WebCrypto so it costs the same on Node
// and on Cloudflare Workers, where a pure-JS hash would run out of CPU time.
// Hashes written by the earlier scrypt code are still accepted.
//
// Every decision re-reads the live profile: a session proves who signed in,
// not that they are still an approved admin.

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { asWorker } from './engine.mjs'

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
  await asWorker(
    db,
    `INSERT INTO auth_secrets (uid, email, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (uid) DO UPDATE SET email = EXCLUDED.email,
       password_hash = EXCLUDED.password_hash, updated_at = now()`,
    [uid, email, await hashPassword(password)]
  )
}

async function userByEmail(db, email) {
  const res = await asWorker(
    db,
    `SELECT id FROM documents WHERE path = 'users' AND lower(data->>'email') = $1 LIMIT 1`,
    [email]
  )
  return res.rows[0]?.id || null
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
// Kept in auth_pending (stack/schema.sql), which the login role reads and the
// data API cannot.

async function failures(db, email) {
  const res = await db.query(
    'SELECT value FROM auth_pending WHERE key = $1 AND expires_at > now()',
    [`pwfail:${email}`]
  )
  const v = res.rows[0]?.value
  return (typeof v === 'string' ? JSON.parse(v) : v)?.n || 0
}

async function recordFailure(db, email) {
  await db.query(
    `INSERT INTO auth_pending (key, value, expires_at)
     VALUES ($1, '{"n":1}'::jsonb, now() + make_interval(secs => $2))
     ON CONFLICT (key) DO UPDATE SET
       value = CASE WHEN auth_pending.expires_at > now()
                    THEN jsonb_build_object('n', (auth_pending.value->>'n')::int + 1)
                    ELSE '{"n":1}'::jsonb END,
       expires_at = CASE WHEN auth_pending.expires_at > now()
                    THEN auth_pending.expires_at ELSE EXCLUDED.expires_at END`,
    [`pwfail:${email}`, LOCK_SECONDS]
  )
}

async function clearFailures(db, email) {
  await db.query('DELETE FROM auth_pending WHERE key = $1', [`pwfail:${email}`])
}

/**
 * @returns {{ ok: true, uid } | { ok: false, reason: 'credentials'|'locked'|'disabled' }}
 */
export async function signInWithPassword(engine, db, { email, password }) {
  const address = normalizeEmail(email)
  if (!address || typeof password !== 'string' || !password) {
    return { ok: false, reason: 'credentials' }
  }
  if ((await failures(db, address)) >= MAX_FAILURES) return { ok: false, reason: 'locked' }
  const uid = await userByEmail(db, address)
  const row = uid
    ? (await asWorker(db, 'SELECT password_hash FROM auth_secrets WHERE uid = $1', [uid])).rows[0]
    : null
  const matches = await verifyPassword(row?.password_hash || DUMMY_HASH, password)
  if (!uid || !row || !matches) {
    await recordFailure(db, address)
    return { ok: false, reason: 'credentials' }
  }
  const profile = await liveProfile(engine, uid)
  // Suspended or disabled people do not get a session at all.
  if (!profile || !['approved', 'pending'].includes(profile.status)) {
    return { ok: false, reason: 'disabled' }
  }
  await clearFailures(db, address)
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
export async function changeOwnPassword(engine, db, { uid, authTime, current, password, now = Date.now() }) {
  if (!uid) return { ok: false, reason: 'unauthenticated' }
  // Within ten minutes of signing in, so a session left open on a shared
  // machine cannot be used to take the account over.
  if (typeof authTime === 'number' && now - authTime * 1000 > 10 * 60 * 1000) {
    return { ok: false, reason: 'stale' }
  }
  const profile = await liveProfile(engine, uid)
  if (!profile?.email) return { ok: false, reason: 'no-profile' }
  const row = (await asWorker(db, 'SELECT password_hash FROM auth_secrets WHERE uid = $1', [uid]))
    .rows[0]
  if (!row || !(await verifyPassword(row.password_hash, String(current || '')))) {
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
export async function bootstrapOrganization(engine, db, { orgName, adminEmail, adminPassword, adminName = '' }) {
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
  const admins = await asWorker(
    db,
    `SELECT 1 FROM documents WHERE path = 'users' AND data->>'role' = 'admin' LIMIT 1`
  )
  if (admins.rows.length) return { created: false }
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
        mustChangePassword: true,
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
