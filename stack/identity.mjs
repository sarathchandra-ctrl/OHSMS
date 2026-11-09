// Sign-in on a dedicated stack. The IdP says who the person is; WEEHS decides
// whether they belong, and as what. No WEEHS Firebase user is created.
//
// Who belongs, in this order: an invite (the founder's is written by
// fulfillment), the IdP groups an admin mapped to roles, or the company's
// email domain (invites.mjs, directory.mjs). Whoever the company's directory
// has deactivated is refused before any of that, and a disabled account
// stays out whatever the IdP says.

import { asWorker } from './engine.mjs'
import { autoJoinFor } from './invites.mjs'
import {
  deactivatedByDirectory,
  expandGroups,
  groupJoinFor,
  roleFromGroups,
  syncRoleFromGroups,
} from './directory.mjs'

const WORKER = { role: 'ohsms_worker', uid: '' }

export async function establishIdentity(engine, db, { sub, email, name, groups = [] }) {
  const uid = String(sub || '').trim()
  const mail = String(email || '')
    .trim()
    .toLowerCase()
  if (!uid || !mail) return { ok: false, reason: 'identity' }
  if (await deactivatedByDirectory(db, mail)) return { ok: false, reason: 'disabled' }

  const existing = await engine.get(WORKER, 'users', uid)
  if (existing) {
    if (existing.status === 'disabled') return { ok: false, reason: 'disabled' }
    const mine = await expandGroups(db, mail, groups)
    const profile = await syncRoleFromGroups(engine, db, uid, existing, mine)
    return { ok: true, uid, profile }
  }

  // Claim the invite and consume it in one statement. Reading it first and
  // deleting it after the user row was written let two first sign-ins for the
  // same address (two tabs, a retried callback) both see it and both become
  // members, and let a revoke that landed in between be ignored.
  const claimed = await asWorker(
    db,
    'DELETE FROM invites WHERE email = $1 RETURNING email, role, name',
    [mail]
  )
  const row = claimed.rows[0]
  // With the groups the directory pushed, and Entra's IDs named (directory.mjs).
  const mine = await expandGroups(db, mail, groups)
  let join
  if (row) {
    join = { role: row.role, name: row.name, by: 'invite' }
  } else {
    // The other sign-in won the claim; it is the same person, so use its user.
    const raced = await engine.get(WORKER, 'users', uid)
    if (raced) return { ok: true, uid, profile: raced }
    const byGroup = await groupJoinFor(db, mine)
    const byDomain = byGroup ? null : await autoJoinFor(db, mail)
    const auto = byGroup || byDomain
    if (!auto) return { ok: false, reason: 'no-invite' }
    join = { ...auto, by: byGroup ? 'groups' : 'domain' }
  }
  // Mapped groups decide the role whenever they give one, invited or not.
  if (join.by !== 'groups') {
    const org = await engine.get(WORKER, 'organization', 'profile')
    join.role = roleFromGroups(org?.groupRoles, mine) || join.role
  }

  try {
    await engine.commit(WORKER, [
      {
        type: 'set',
        path: 'users',
        id: uid,
        merge: false,
        data: {
          role: join.role,
          status: 'approved',
          name: name || join.name || mail,
          email: mail,
          mustChangePassword: false,
          joinedBy: join.by,
        },
      },
    ])
  } catch (err) {
    if (row) {
      // Put the invite back so the person can try again, rather than leaving
      // them with neither an invite nor an account.
      await asWorker(
        db,
        `INSERT INTO invites (email, role, name) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO NOTHING`,
        [row.email, row.role, row.name]
      )
    }
    throw err
  }
  const profile = await engine.get(WORKER, 'users', uid)
  return { ok: true, uid, profile }
}
