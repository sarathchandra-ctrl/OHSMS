import {
  addDoc,
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { onReadError } from '../../../shared/org/readError'
import { reserveDocId } from '../../../shared/docId/reserve'
import { COLLECTION_READ_CAP } from '../../../shared/org/orgData'

// Faithful to the original portal's Internal Audit data model:
//   organizations/{orgId}/auditPlans     — schedules with an execution matrix
//   organizations/{orgId}/auditFindings  — executed audits with findings + CAPA
const plansCol = (orgId) => collection(db, 'organizations', orgId, 'auditPlans')
const findingsCol = (orgId) =>
  collection(db, 'organizations', orgId, 'auditFindings')

// Capped, like every other live register. An ISO 45001 programme accumulates
// audit plans and findings for the life of the organization and nothing prunes
// them, so neither of these has an upper bound of its own.
export function subscribeAuditPlans(orgId, callback) {
  return onSnapshot(
    query(plansCol(orgId), limit(COLLECTION_READ_CAP)),
    (snap) => callback(snap.docs.map((d) => ({ firebaseKey: d.id, ...d.data() }))),
    onReadError('audit plans', callback),
  )
}

export function subscribeAuditFindings(orgId, callback) {
  return onSnapshot(
    query(findingsCol(orgId), limit(COLLECTION_READ_CAP)),
    (snap) => callback(snap.docs.map((d) => ({ firebaseKey: d.id, ...d.data() }))),
    onReadError('audit findings', callback),
  )
}

export async function createAuditPlan(orgId, payload) {
  const ref = await addDoc(plansCol(orgId), {
    ...payload,
    docId: await reserveDocId(orgId, 'audit'),
    createdAt: payload.createdAt || new Date().toISOString(),
    _serverCreatedAt: serverTimestamp(),
  })
  return ref.id
}

export async function createAuditFinding(orgId, payload) {
  const ref = await addDoc(findingsCol(orgId), {
    ...payload,
    docId: await reserveDocId(orgId, 'auditFindings'),
    _serverCreatedAt: serverTimestamp(),
  })
  return ref.id
}

export function updateAuditFinding(orgId, firebaseKey, data) {
  return updateDoc(
    doc(db, 'organizations', orgId, 'auditFindings', firebaseKey),
    data,
  )
}
