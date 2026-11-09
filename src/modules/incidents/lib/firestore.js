// ─────────────────────────────────────────────────────────────────────────────
// Shared data-access base: organizations, users, the public org-name index, and
// the append-only audit log. Domain data (incidents, illnesses) lives in its own
// module (incidents.js / illnesses.js) which reuses these helpers.
// ─────────────────────────────────────────────────────────────────────────────
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  query,
  orderBy,
  onSnapshot,
  limit,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { onReadError } from '../../../shared/org/readError'
import { AUDIT } from './audit'
import { logAudit as logOrgAudit, auditCol } from '../../../shared/org/orgData'

// ── Path helpers ─────────────────────────────────────────────────────────────
export const orgRef = () => doc(db, 'organization', 'profile')
export const userRef = (uid) => doc(db, 'users', uid)
export { auditCol }

// ── Audit log ─────────────────────────────────────────────────────────────────
// One implementation, in shared/org/orgData; this wrapper adds only the module
// key and the default target. The private copy it replaces omitted `module`, so
// entries written through incidents.js / illnesses.js / injuries.js displayed as
// "Core" in Admin → Audit Log — while pages/Incidents.jsx called the shared one
// directly, so the same module was writing two different shapes.
export const logAudit = (actor, action, details = {}) =>
  logOrgAudit(actor, action, { module: 'incidents', target: 'incident', ...details })

export function subscribeAuditLogs(cb) {
  const q = query(auditCol(), orderBy('at', 'desc'), limit(200))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('the incident audit log', cb),
  )
}

// ── Organizations & users ─────────────────────────────────────────────────────


// Delegated to the shared ref-counted users listener (one app-wide).
export { subscribeOrgUsers } from '../../../shared/org/orgData'

/** Live org document. */
export function subscribeOrg(cb) {
  return onSnapshot(
    orgRef(),
    (snap) => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onReadError('the organization', cb, null),
  )
}

export async function setUserStatus(uid, status, actor, userLabel) {
  await updateDoc(userRef(uid), { status })
  await logAudit(actor, AUDIT.USER_STATUS, {
    target: 'user',
    targetId: uid,
    targetLabel: userLabel || uid,
    summary: `Set status → ${status}`,
  })
}

export async function setUserRole(uid, role, actor, userLabel) {
  await updateDoc(userRef(uid), { role })
  await logAudit(actor, AUDIT.USER_ROLE, {
    target: 'user',
    targetId: uid,
    targetLabel: userLabel || uid,
    summary: `Set role → ${role}`,
  })
}
