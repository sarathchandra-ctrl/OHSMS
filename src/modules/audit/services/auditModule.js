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
const plansCol = () => collection(db, 'auditPlans')
const findingsCol = () =>
  collection(db, 'auditFindings')

// Capped, like every other live register. An ISO 45001 programme accumulates
// audit plans and findings for the life of the organization and nothing prunes
// them, so neither of these has an upper bound of its own.
export function subscribeAuditPlans(callback) {
  return onSnapshot(
    query(plansCol(), limit(COLLECTION_READ_CAP)),
    (snap) => callback(snap.docs.map((d) => ({ docKey: d.id, ...d.data() }))),
    onReadError('audit plans', callback),
  )
}

export function subscribeAuditFindings(callback) {
  return onSnapshot(
    query(findingsCol(), limit(COLLECTION_READ_CAP)),
    (snap) => callback(snap.docs.map((d) => ({ docKey: d.id, ...d.data() }))),
    onReadError('audit findings', callback),
  )
}

export async function createAuditPlan(payload) {
  const ref = await addDoc(plansCol(), {
    ...payload,
    docId: await reserveDocId('audit'),
    createdAt: payload.createdAt || new Date().toISOString(),
    _serverCreatedAt: serverTimestamp(),
  })
  return ref.id
}

export async function createAuditFinding(payload) {
  const ref = await addDoc(findingsCol(), {
    ...payload,
    docId: await reserveDocId('auditFindings'),
    _serverCreatedAt: serverTimestamp(),
  })
  return ref.id
}

export function updateAuditFinding(docKey, data) {
  return updateDoc(
    doc(db, 'auditFindings', docKey),
    data,
  )
}
