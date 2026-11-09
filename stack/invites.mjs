// Adding people to a dedicated environment.
//
// A first sign-in is admitted only against an invite (stack/identity.mjs), and
// until this file the only invite ever written was the founder's, at
// fulfillment. Everyone else the company's IdP authenticated was told there
// was no account on this organization, so a dedicated environment was a
// one-person environment. The Employees page could not help: it creates WEEHS
// Firebase accounts, which this stack does not have.
//
// Being authenticated by the company's IdP says who someone is. It does not
// say they belong in this tenant, or with what role — an IdP usually holds the
// whole company, contractors included. That decision is an admin's, and this
// is where they make it.
//
// Every call re-reads the caller's live profile. A session token proves who
// signed in, not that they are still an approved admin (the S-19 reasoning in
// storage.rules): an admin demoted a minute ago must not invite anyone.
//
// invites is FORCE ROW LEVEL SECURITY with no browser grant, so these run as
// the worker role, and the decisions below are the whole of the enforcement.

import { asWorker } from './engine.mjs'

const WORKER = { role: 'ohsms_worker', uid: '' }

// The four roles the product knows (src/shared/auth/permissions.js ROLES).
export const INVITE_ROLES = ['admin', 'manager', 'member', 'auditor']
export const MAX_PENDING_INVITES = 500

// A local part, then dot-separated labels that are each non-empty: the old
// pattern took `a@b..test` and `a@.b.test`, which no mail server delivers to.
const EMAIL = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:.]+(?:\.[^\s@<>()"',;:.]+)+$/

function refuse(reason) {
  return { ok: false, reason }
}

export function normalizeEmail(value) {
  // A string or nothing: String(['a@b.c']) is 'a@b.c', and a JSON body can
  // carry any shape.
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

/** The caller, if they are an approved admin who has cleared the password gate. */
export async function adminOf(engine, uid) {
  if (!uid) return null
  const profile = await engine.get(WORKER, 'users', uid)
  if (!profile || profile.status !== 'approved' || profile.mustChangePassword === true) return null
  if (profile.role !== 'admin') return null
  return profile
}

/**
 * Invite `email` into the caller's organization with `role`.
 * Re-inviting a pending address in the same organization updates it.
 * @returns {{ ok: true, email, role, emailed: boolean } | { ok: false, reason }}
 */
export async function inviteMember(
  engine,
  db,
  { uid, email, role, name, mail = null, origin = '' }
) {
  const admin = await adminOf(engine, uid)
  if (!admin) return refuse('not-admin')
  const address = normalizeEmail(email)
  if (!address) return refuse('email')
  if (!INVITE_ROLES.includes(role)) return refuse('role')
  const label = cleanName(name) || address

  // Already a member: their role is changed on the Employees page, not by a
  // second invite.
  const member = await asWorker(
    db,
    `SELECT 1 FROM documents WHERE path = 'users' AND lower(data->>'email') = $1 LIMIT 1`,
    [address]
  )
  if (member.rows.length) return refuse('already-member')

  const pending = await asWorker(db, 'SELECT 1 FROM invites WHERE email = $1', [address])
  if (!pending.rows[0]) {
    const count = await asWorker(db, 'SELECT count(*)::int AS n FROM invites')
    if ((count.rows[0]?.n ?? 0) >= MAX_PENDING_INVITES) return refuse('too-many')
  }

  // Re-inviting a pending address updates its role and name.
  await asWorker(
    db,
    `INSERT INTO invites (email, role, name) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, name = EXCLUDED.name`,
    [address, role, label]
  )

  let emailed = false
  if (typeof mail === 'function') {
    const where = origin ? ` at ${origin}` : ''
    const orgDoc = await engine.get(WORKER, 'organization', 'profile')
    const org = cleanName(orgDoc?.name) || 'your organization'
    const sent = await mail({
      to: address,
      subject: `You have been invited to ${org} on WEEHS`,
      text:
        `${cleanName(admin.name) || 'An administrator'} invited you to ${org}` +
        ` on WEEHS as ${role}.\n\n` +
        `Sign in${where} with your company account (choose "Continue with company sign-in").` +
        ` Use the same email address this message was sent to.\n\n` +
        `If you were not expecting this, you can ignore it.`,
    }).catch(() => ({ sent: false }))
    emailed = sent?.sent === true
  }
  return { ok: true, email: address, role, emailed }
}

/** The pending invites, in address order. */
export async function listInvites(engine, db, { uid }) {
  const admin = await adminOf(engine, uid)
  if (!admin) return refuse('not-admin')
  const rows = await asWorker(
    db,
    'SELECT email, role, name FROM invites ORDER BY email LIMIT $1',
    [MAX_PENDING_INVITES]
  )
  return { ok: true, invites: rows.rows }
}

/** Withdraw a pending invite. Idempotent. */
export async function revokeInvite(engine, db, { uid, email }) {
  const admin = await adminOf(engine, uid)
  if (!admin) return refuse('not-admin')
  const address = normalizeEmail(email)
  if (!address) return refuse('email')
  const res = await asWorker(db, 'DELETE FROM invites WHERE email = $1', [address])
  return { ok: true, removed: res.affectedRows > 0 }
}

// ── Joining automatically, by email domain ──────────────────────────────────
// Inviting one person at a time does not fit a company of thousands whose
// identity provider already holds everyone. An admin can say instead: anyone
// the company's IdP signs in with an address at these domains joins, with
// this role. The IdP still decides who can sign in at all, and with what
// checks (MFA, disabled accounts); this decides who belongs, as an invite
// does. Never as admin: an administrator is always a named decision.

export const AUTO_JOIN_ROLES = ['member', 'auditor', 'manager']
export const MAX_AUTO_JOIN_DOMAINS = 10
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/

/** The setting as stored, or null when off or not something this accepts. */
export function cleanAutoJoin(value) {
  if (!value || typeof value !== 'object') return null
  const role = AUTO_JOIN_ROLES.includes(value.role) ? value.role : null
  const domains = Array.isArray(value.domains)
    ? [
        ...new Set(
          value.domains
            .filter((d) => typeof d === 'string')
            .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
            .filter((d) => DOMAIN.test(d))
        ),
      ].slice(0, MAX_AUTO_JOIN_DOMAINS)
    : []
  return role && domains.length ? { domains, role } : null
}

export async function getAutoJoin(engine, db, { uid }) {
  const admin = await adminOf(engine, uid)
  if (!admin) return refuse('not-admin')
  const org = await engine.get(WORKER, 'organization', 'profile')
  return { ok: true, autoJoin: cleanAutoJoin(org?.autoJoin) }
}

/** Turn it on (domains and a role) or off (no domains). */
export async function setAutoJoin(engine, db, { uid, domains, role }) {
  const admin = await adminOf(engine, uid)
  if (!admin) return refuse('not-admin')
  if (!Array.isArray(domains)) return refuse('domains')
  const wanted = domains.filter((d) => typeof d === 'string' && d.trim())
  if (wanted.length > MAX_AUTO_JOIN_DOMAINS) return refuse('too-many')
  let next = null
  if (wanted.length) {
    if (!AUTO_JOIN_ROLES.includes(role)) return refuse('role')
    next = cleanAutoJoin({ domains: wanted, role })
    // Every domain typed must be one: a typo silently dropped would leave
    // people out with nobody knowing why.
    if (
      !next ||
      next.domains.length !==
        new Set(wanted.map((d) => d.trim().toLowerCase().replace(/^@/, ''))).size
    ) {
      return refuse('domains')
    }
  }
  await engine.commit(WORKER, [
    { type: 'update', path: 'organization', id: 'profile', data: { autoJoin: next } },
  ])
  return { ok: true, autoJoin: next }
}

/**
 * The organization and role an address joins automatically, if any. The
 * stored setting is read through cleanAutoJoin again: an admin can also write
 * the organization document directly, and nothing written there may make
 * someone an admin.
 */
export async function autoJoinFor(db, email) {
  const domain = String(email || '')
    .split('@')[1]
    ?.toLowerCase()
  if (!domain) return null
  const rows = await asWorker(
    db,
    `SELECT id, data->'autoJoin' AS auto FROM documents WHERE path = 'organization' AND id = 'profile' AND data ? 'autoJoin'`
  )
  for (const row of rows.rows) {
    const auto = cleanAutoJoin(typeof row.auto === 'string' ? JSON.parse(row.auto) : row.auto)
    if (auto && auto.domains.includes(domain)) return { role: auto.role }
  }
  return null
}
