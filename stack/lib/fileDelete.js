// ─────────────────────────────────────────────────────────────────────────────
// May this caller delete this file?
//
// WHY THIS EXISTS. A session token proves who signed in. It used to be what
// file rules read the caller's role off — the presented ID TOKEN, because a Storage rule cannot query Firestore. A token is
// valid until it expires — up to an hour — so a manager suspended, demoted or
// moved to another tenant kept the ability to delete any file in their old
// organization for the rest of that hour. Stripping the claim does not reach
// back into a token already issued, and revoking refresh tokens does not
// either: rules never consult tokensValidAfterTime. That is SECURITY.md S-19.
//
// Deleting is the operation where that matters. It is irreversible, the files
// ARE the evidence — incident photos, permit documents, isolation procedure
// photos, drill evidence — and it leaves nothing in the audit trail, which only
// records what the app chose to write.
//
// So the check lives here, where the profile is read LIVE on every call and
// the decision runs under a test suite. /presign op 'delete' and the
// deleteOrgFile job are the only ways a signed-in user can remove a file, and
// both ask this.
//
// Pure, so every branch is exercised without the Admin SDK — which is the part
// that cannot run in a unit test.
// ─────────────────────────────────────────────────────────────────────────────

import { accountGated } from './accountGate.js'
/** Roles that may delete. Mirrors isManager in stack/policy.mjs. */
export const DELETING_ROLES = ['admin', 'manager']

/**
 * Is `path` one of this application's stored files?
 *
 * The client sends the path, so this is the boundary and it is the one check
 * that must not be got wrong. `..` is refused outright rather than
 * normalised: a path that needs normalising to be safe is a path worth
 * refusing, and the app never produces one — storagePath() builds
 * `files/<kind>/<rand>-<file>` and sanitises every segment.
 */
export function isAppFilePath(path) {
  const p = String(path || '')
  if (!p) return false
  return p.startsWith('files/') && !p.includes('..') && !p.includes('\\') && !p.includes('\0')
}

/**
 * The decision, from the LIVE profile and the requested path.
 *
 * Returns `{ ok }` or `{ ok: false, reason }`. Reasons are for the server log
 * and for tests; the callable deliberately does not hand most of them back to
 * the caller, because "your profile says member" and "that file belongs to
 * another organization" are both just "no" to somebody probing.
 *
 * Mirrors isManager in stack/policy.mjs in full — including the clause a claim
 * could never carry: an account still holding the password a provisioning admin
 * typed for it reaches NOTHING in Firestore, and used to be able to delete in
 * Storage regardless. That is a credential the admin knows, so an action taken
 * with it is not attributable to the employee.
 */
export function mayDeleteFile(profile, path) {
  if (!profile) return { ok: false, reason: 'no-profile' }
  if (profile.status !== 'approved') return { ok: false, reason: 'not-approved' }
  // Read defensively: profiles written before this field existed have no such
  // key, and treating that as "must change" would refuse every established
  // manager. Only an explicit true refuses.
  if (accountGated(profile)) return { ok: false, reason: 'must-change-password' }
  if (!DELETING_ROLES.includes(profile.role)) return { ok: false, reason: 'role' }
  if (!isAppFilePath(path)) return { ok: false, reason: 'foreign-path' }
  return { ok: true }
}
