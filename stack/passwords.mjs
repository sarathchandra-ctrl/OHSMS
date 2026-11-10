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
import { newTotpSecret, openSecret, otpauthUri, sealSecret, verifyTotp } from './totp.mjs'
import { accountGated } from './lib/accountGate.js'

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

// The one profile carrying this address, or null. An address on two profiles
// signs in to neither: picking one (LIMIT 1, no order) let whoever planted a
// copy of a colleague's address win the sign-in and the reset link.
async function userByEmail(db, email) {
  const row = await db
    .prepare(
      "SELECT min(id) AS id, count(*) AS n FROM documents WHERE path = 'users' AND lower(json_extract(data, '$.email')) = ?"
    )
    .bind(email)
    .first()
  return row && Number(row.n) === 1 ? row.id : null
}

/** Whether any profile carries this address at all. */
async function emailTaken(db, email) {
  const row = await db
    .prepare(
      "SELECT 1 AS hit FROM documents WHERE path = 'users' AND lower(json_extract(data, '$.email')) = ? LIMIT 1"
    )
    .bind(email)
    .first()
  return Boolean(row)
}

/**
 * End every session this person holds: tokens carry the epoch they were
 * issued under, and a request with an older one is signed out
 * (handler.mjs liveSession). The caller's own session, when it should
 * survive, gets a fresh token (`reissue`, handler.mjs onRpc).
 */
export async function bumpSessionEpoch(engine, uid) {
  if (!uid) return
  await engine.commit(WORKER, [
    { type: 'update', path: 'users', id: uid, data: { sessionEpoch: { __ohsms: 'increment', n: 1 } } },
  ])
}

/** The epoch a new token for this person is issued under. */
export async function sessionEpochOf(db, uid) {
  if (!uid) return 0
  const row = await db
    .prepare("SELECT json_extract(data, '$.sessionEpoch') AS ep FROM documents WHERE path = 'users' AND id = ?")
    .bind(uid)
    .first()
  return Number.isInteger(row?.ep) ? row.ep : 0
}

async function liveProfile(engine, uid) {
  if (!uid) return null
  return engine.get(WORKER, 'users', uid)
}

/** The caller, if they are an approved admin who has cleared the password gate. */
export async function liveAdmin(engine, uid) {
  const p = await liveProfile(engine, uid)
  if (!p || p.status !== 'approved' || p.role !== 'admin' || accountGated(p)) {
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

// After a new password is set, every lock on the address goes, from every
// source. The admin reset and the reset link called clearFailures with no
// source, which deleted `pwfail:<email>:undefined` and left the real
// per-source lock in place: the person stayed locked out on their own machine.
async function clearAllFailures(db, email) {
  await db
    .prepare("DELETE FROM auth_pending WHERE key = ? OR (key >= ? AND key < ?)")
    .bind(`pwfail:${email}`, `pwfail:${email}:`, `pwfail:${email};`)
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
  // The password was right. With two-step login on, that earns a short-lived
  // ticket for the code step, not a session (completeTotpSignIn).
  if (await totpRow(db, uid)) {
    const ticket = randomBytes(32).toString('base64url')
    await db
      .prepare('INSERT INTO auth_pending (key, value, expires_at) VALUES (?, ?, ?)')
      .bind(`mfaticket:${sha256(ticket)}`, JSON.stringify({ uid }), Date.now() + TICKET_TTL_S * 1000)
      .run()
    return { ok: true, uid, mfa: true, ticket }
  }
  return { ok: true, uid }
}

// ── Two-step login (authenticator app, stack/totp.mjs) ──────────────────────
// The secret lives in auth_totp, sealed, and never reaches /data. The profile
// carries only `mfaEnabled` (written by the server, never by a client) and
// `mfaRequired` (an admin's), which the access rules read (accountGated).

const TICKET_TTL_S = 5 * 60
const TICKET_TRIES = 5
const ENROL_TTL_S = 10 * 60

async function totpRow(db, uid) {
  return db.prepare('SELECT secret, last_step FROM auth_totp WHERE uid = ?').bind(uid).first()
}

async function setMfaEnabled(engine, uid, on) {
  await engine.commit(WORKER, [{ type: 'update', path: 'users', id: uid, data: { mfaEnabled: on } }])
}

/** Begin setting up two-step login: a new secret, held until a code confirms it. */
export async function startTotpEnrollment(engine, db, { uid, master, issuer = 'OHSMS' }) {
  const profile = await liveProfile(engine, uid)
  // A temporary password is replaced first; two-step login is the next step.
  if (!profile || profile.status !== 'approved' || profile.mustChangePassword === true) {
    return { ok: false, reason: 'not-allowed' }
  }
  if (!master) return { ok: false, reason: 'not-configured' }
  if (await totpRow(db, uid)) return { ok: false, reason: 'already-on' }
  const secret = newTotpSecret()
  await db
    .prepare(
      `INSERT INTO auth_pending (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
    )
    .bind(`totpenrol:${uid}`, sealSecret(secret, master), Date.now() + ENROL_TTL_S * 1000)
    .run()
  return { ok: true, secret, uri: otpauthUri({ issuer, account: profile.email || uid, secret }) }
}

/** Finish setting up: the first code from the app proves it holds the secret. */
export async function confirmTotpEnrollment(engine, db, { uid, code, master, nowMs = Date.now() }) {
  const row = await db
    .prepare('SELECT value FROM auth_pending WHERE key = ? AND expires_at > ?')
    .bind(`totpenrol:${uid}`, nowMs)
    .first()
  if (!row) return { ok: false, reason: 'expired' }
  const secret = safeOpen(row.value, master)
  if (!secret) return { ok: false, reason: 'expired' }
  // Bounded like every other code check, though only the person setting up
  // reaches it: the pending secret then has to be started again.
  if (!(await takeTry(db, `totpenroltry:${uid}`, TICKET_TRIES, ENROL_TTL_S))) {
    await dropKeys(db, `totpenrol:${uid}`, `totpenroltry:${uid}`)
    return { ok: false, reason: 'expired' }
  }
  const step = verifyTotp(secret, code, { nowMs })
  if (step === null) return { ok: false, reason: 'code' }
  await db
    .prepare('INSERT OR REPLACE INTO auth_totp (uid, secret, last_step, enabled_at) VALUES (?, ?, ?, ?)')
    .bind(uid, sealSecret(secret, master), step, nowMs)
    .run()
  await dropKeys(db, `totpenrol:${uid}`, `totpenroltry:${uid}`)
  await setMfaEnabled(engine, uid, true)
  // Turning it on is often a reaction to a password that may be known:
  // sessions opened with the password alone end here.
  await bumpSessionEpoch(engine, uid)
  return { ok: true, reissue: true }
}

// A secret sealed under another master (DATA_KEY_MASTER changed) cannot be
// opened. That is a wrong code, not a server error: an admin resets it.
function safeOpen(sealed, master) {
  try {
    return master ? openSecret(sealed, master) : null
  } catch {
    return null
  }
}

/** Check a code against a person's stored secret, and spend its step. */
async function spendCode(db, uid, code, master, nowMs) {
  const row = await totpRow(db, uid)
  if (!row) return false
  const secret = safeOpen(row.secret, master)
  if (!secret) return false
  const step = verifyTotp(secret, code, { nowMs, lastStep: Number(row.last_step) })
  if (step === null) return false
  // Conditional, so two requests with the same code cannot both pass.
  const res = await db
    .prepare('UPDATE auth_totp SET last_step = ? WHERE uid = ? AND last_step < ?')
    .bind(step, uid, step)
    .run()
  return (res?.meta?.changes ?? res?.changes ?? 1) > 0
}

// Code attempts are counted BEFORE the code is checked. Checking first and
// counting after let a burst of parallel requests all read the count as
// zero: 200 simultaneous wrong codes on one ticket were all evaluated, where
// five were meant to be. bump() is one atomic statement that returns the new
// count, so taking a try is the check.
//
//   mfatries:<ticket>  TICKET_TRIES per ticket, then the ticket is burnt;
//   totpfail:<uid>     TOTP_FAILURES_PER_ACCOUNT wrong codes lock the code
//                      step for that person for LOCK_SECONDS. A right
//                      password does not clear it (it used to restart the
//                      count with a fresh ticket); only a right code does;
//   totpip:<ip>        MAX_FAILURES_PER_SOURCE tries from one source.
export const TOTP_FAILURES_PER_ACCOUNT = 10

async function takeTry(db, key, limit, ttlSeconds) {
  return (await bump(db, key, ttlSeconds)) <= limit
}

async function refundTry(db, key) {
  await db
    .prepare('UPDATE auth_pending SET value = max(CAST(value AS INTEGER) - 1, 0) WHERE key = ?')
    .bind(key)
    .run()
}

async function dropKeys(db, ...keys) {
  for (const key of keys) await db.prepare('DELETE FROM auth_pending WHERE key = ?').bind(key).run()
}

/**
 * The second step of signing in. Returns { ok, uid } or { ok: false, reason }:
 * 'ticket' (expired, spent or burnt), 'code', 'locked', 'throttled', 'disabled'.
 */
export async function completeTotpSignIn(engine, db, { ticket, code, master, ip = '', nowMs = Date.now() }) {
  const source = String(ip || '').slice(0, 64)
  if (typeof ticket !== 'string' || ticket.length < 20) return { ok: false, reason: 'ticket' }
  const hash = sha256(ticket)
  const key = `mfaticket:${hash}`
  const triesKey = `mfatries:${hash}`
  const row = await db
    .prepare('SELECT value FROM auth_pending WHERE key = ? AND expires_at > ?')
    .bind(key, nowMs)
    .first()
  if (!row) return { ok: false, reason: 'ticket' }
  const { uid } = JSON.parse(row.value)
  const ipKey = `totpip:${source}`
  const failKey = `totpfail:${uid}`
  if (!(await takeTry(db, ipKey, MAX_FAILURES_PER_SOURCE, LOCK_SECONDS))) {
    return { ok: false, reason: 'throttled' }
  }
  if (!(await takeTry(db, failKey, TOTP_FAILURES_PER_ACCOUNT, LOCK_SECONDS))) {
    return { ok: false, reason: 'locked' }
  }
  if (!(await takeTry(db, triesKey, TICKET_TRIES, TICKET_TTL_S))) {
    await dropKeys(db, key)
    return { ok: false, reason: 'ticket' }
  }
  if (await spendCode(db, uid, code, master, nowMs)) {
    // A right code is not a failure: give back this source's try, and clear
    // the person's count. The ticket is spent.
    await refundTry(db, ipKey)
    await dropKeys(db, key, triesKey, failKey)
    const profile = await liveProfile(engine, uid)
    if (!profile || !['approved', 'pending'].includes(profile.status)) return { ok: false, reason: 'disabled' }
    return { ok: true, uid }
  }
  return { ok: false, reason: 'code' }
}

/** Turn two-step login off for yourself, with a current code. Not when an admin requires it. */
export async function disableOwnTotp(engine, db, { uid, code, master, nowMs = Date.now() }) {
  const profile = await liveProfile(engine, uid)
  if (!profile) return { ok: false, reason: 'not-allowed' }
  if (profile.mfaRequired === true) return { ok: false, reason: 'required' }
  // The same per-person count as signing in: a stolen session must not be
  // able to guess its way to switching the second step off.
  const failKey = `totpfail:${uid}`
  if (!(await takeTry(db, failKey, TOTP_FAILURES_PER_ACCOUNT, LOCK_SECONDS))) {
    return { ok: false, reason: 'locked' }
  }
  if (!(await spendCode(db, uid, code, master, nowMs))) return { ok: false, reason: 'code' }
  await dropKeys(db, failKey)
  await db.prepare('DELETE FROM auth_totp WHERE uid = ?').bind(uid).run()
  await setMfaEnabled(engine, uid, false)
  await bumpSessionEpoch(engine, uid)
  return { ok: true, reissue: true }
}

/** An admin clears someone's two-step login (a lost phone). They set it up again. */
export async function resetMemberTotp(engine, db, { uid, targetUid }) {
  const admin = await liveAdmin(engine, uid)
  if (!admin) return { ok: false, reason: 'not-admin' }
  if (!targetUid || !(await liveProfile(engine, targetUid))) return { ok: false, reason: 'no-user' }
  await db.prepare('DELETE FROM auth_totp WHERE uid = ?').bind(targetUid).run()
  await setMfaEnabled(engine, targetUid, false)
  // A lost phone may be a stolen one, with a session open on it.
  await bumpSessionEpoch(engine, targetUid)
  return { ok: true }
}

/** Is two-step login on for this person? */
export async function totpStatus(db, { uid }) {
  return { ok: true, enabled: Boolean(uid && (await totpRow(db, uid))) }
}

/** Sign out every other device: this session continues on a fresh token. */
export async function signOutOtherSessions(engine, { uid }) {
  const profile = await liveProfile(engine, uid)
  if (!profile) return { ok: false, reason: 'not-allowed' }
  await bumpSessionEpoch(engine, uid)
  return { ok: true, reissue: true }
}

/** An admin ends every session a person holds (a lost laptop, a leaver). */
export async function revokeMemberSessions(engine, { uid, targetUid }) {
  const admin = await liveAdmin(engine, uid)
  if (!admin) return { ok: false, reason: 'not-admin' }
  if (!targetUid || !(await liveProfile(engine, targetUid))) return { ok: false, reason: 'no-user' }
  await bumpSessionEpoch(engine, targetUid)
  return { ok: true }
}

/** An admin adds a person, with a temporary password they must replace. */
export async function createMember(engine, db, { uid, email, name, role, password }) {
  const admin = await liveAdmin(engine, uid)
  if (!admin) return { ok: false, reason: 'not-admin' }
  const address = normalizeEmail(email)
  if (!address) return { ok: false, reason: 'email' }
  if (!MEMBER_ROLES.includes(role)) return { ok: false, reason: 'role' }
  if (passwordProblem(password)) return { ok: false, reason: 'policy' }
  if (await emailTaken(db, address)) return { ok: false, reason: 'already-member' }
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
  await clearAllFailures(db, normalizeEmail(target.email))
  await bumpSessionEpoch(engine, targetUid)
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
  // Whoever else holds a session on the old password loses it; this one
  // continues on a fresh token.
  await bumpSessionEpoch(engine, uid)
  return { ok: true, reissue: true }
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

// ── The first sign-up ───────────────────────────────────────────────────────
// A new installation with nobody in it shows "Sign up" on the sign-in page.
// The first person to use it becomes the administrator and names the
// organization; everyone after them is added by an administrator (Employees
// → Add employee). It is the server that decides it is open, never the page,
// and it closes for good the moment any account exists, including one the
// operator created through ADMIN_EMAIL / ADMIN_PASSWORD.
//
// Two people pressing it at once: one statement claims the right to be first
// (auth_pending, a key that can be inserted once), so exactly one succeeds.
//
// On a fresh deployment the address is public before its owner has signed
// up, and whoever gets there first would be its administrator. SETUP_CODE,
// when the operator sets it, closes that window: the sign-up then also asks
// for the code.

const FIRST_ADMIN_CLAIM = 'setup:first-admin'

/** Is the first sign-up open: nobody in this installation yet, and no claim? */
export async function firstSignUpOpen(db) {
  const anyone = await db.prepare("SELECT 1 AS one FROM documents WHERE path = 'users' LIMIT 1").first()
  if (anyone) return false
  const claimed = await db.prepare('SELECT 1 AS one FROM auth_pending WHERE key = ?').bind(FIRST_ADMIN_CLAIM).first()
  return !claimed
}

const sameCode = (a, b) => {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  return x.length === y.length && timingSafeEqual(x, y)
}

export async function firstSignUp(engine, db, { orgName, name, email, password, code, setupCode = '' }) {
  if (!(await firstSignUpOpen(db))) return { ok: false, reason: 'closed' }
  if (setupCode && !sameCode(code, setupCode)) return { ok: false, reason: 'setup-code' }
  const address = normalizeEmail(email)
  if (!address) return { ok: false, reason: 'email' }
  const person = cleanName(name)
  if (!person) return { ok: false, reason: 'name' }
  const org = cleanName(orgName)
  if (!org) return { ok: false, reason: 'org' }
  if (passwordProblem(password)) return { ok: false, reason: 'policy' }
  // The claim: inserted once, ever. Whoever's insert lands is first.
  const claim = await db
    .prepare('INSERT INTO auth_pending (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING')
    .bind(FIRST_ADMIN_CLAIM, address, Number.MAX_SAFE_INTEGER)
    .run()
  if (!Number(claim?.meta?.changes)) return { ok: false, reason: 'closed' }
  // Checked again under the claim: an operator's bootstrap may have landed
  // between the first look and the claim.
  const anyone = await db.prepare("SELECT 1 AS one FROM documents WHERE path = 'users' LIMIT 1").first()
  if (anyone) return { ok: false, reason: 'closed' }
  const id = randomUUID()
  try {
    const stored = await engine.get(WORKER, 'organization', 'profile')
    await engine.commit(WORKER, [
      stored
        ? { type: 'update', path: 'organization', id: 'profile', data: { name: org } }
        : { type: 'set', path: 'organization', id: 'profile', merge: false, data: { name: org, address: '', createdBy: id } },
      {
        type: 'set',
        path: 'users',
        id,
        merge: false,
        data: {
          name: person,
          email: address,
          role: 'admin',
          status: 'approved',
          // They chose this password themselves, just now.
          mustChangePassword: false,
          dept: '',
          department: '',
          access: { sites: [], regions: [], entities: [] },
          createdBy: 'first-sign-up',
          createdAt: { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 },
        },
      },
    ])
    await storePassword(db, { uid: id, email: address, password })
  } catch (err) {
    // Nothing was created: free the claim so the owner can try again.
    await engine.commit(WORKER, [{ type: 'remove', path: 'users', id }]).catch(() => {})
    await db.prepare('DELETE FROM auth_pending WHERE key = ?').bind(FIRST_ADMIN_CLAIM).run()
    throw err
  }
  return { ok: true, uid: id, email: address }
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
  await clearAllFailures(db, normalizeEmail(profile.email || claim.email))
  // Whoever was in the account before the reset is not after it.
  await bumpSessionEpoch(engine, claim.uid)
  return { ok: true }
}
