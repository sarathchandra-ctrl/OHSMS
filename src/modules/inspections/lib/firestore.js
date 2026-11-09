// ─────────────────────────────────────────────────────────────────────────────
// All Firestore access goes through here: org-scoped paths for inspection
// templates + records, the shared organizations/users/orgIndex collections, and
// an append-only audit trail. Mirrors the Fire Marshal data layer conventions.
// ─────────────────────────────────────────────────────────────────────────────
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  runTransaction,
  limit,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { reserveDocId } from '../../../shared/docId/reserve'
import { logAudit as logOrgAudit, COLLECTION_READ_CAP } from '../../../shared/org/orgData'
import { onReadError } from '../../../shared/org/readError'
import { reportError } from '../../../shared/monitoring'

// ── Path helpers ─────────────────────────────────────────────────────────────
const templateCol = (orgId) => collection(db, 'organizations', orgId, 'inspectionTemplates')
const templateRef = (orgId, id) => doc(db, 'organizations', orgId, 'inspectionTemplates', id)
const recordCol = (orgId) => collection(db, 'organizations', orgId, 'inspectionRecords')
const recordRef = (orgId, id) => doc(db, 'organizations', orgId, 'inspectionRecords', id)

// ── Audit log ────────────────────────────────────────────────────────────────
// One implementation, in shared/org/orgData; this wrapper adds only the module
// key and the default target. The private copy it replaces omitted both
// `module` and `source`, so inspection entries read as "Core" in the unified
// Audit Log with no origin recorded.
const logAudit = (orgId, actor, action, details = {}) =>
  logOrgAudit(orgId, actor, action, { module: 'inspections', target: 'template', ...details })

// ── Organizations & users ──────────────────────────────────────────────────────

// Delegated to the shared ref-counted org-users listener (one per org app-wide).
export { subscribeOrgUsers } from '../../../shared/org/orgData'

// ── Inspection templates ───────────────────────────────────────────────────────

export function subscribeTemplates(orgId, cb) {
  // The only uncapped listener left in this module, and templates carry their
  // whole `fields` AND `assignments` arrays — so it is also the heaviest.
  const q = query(templateCol(orgId), orderBy('createdAt', 'desc'), limit(COLLECTION_READ_CAP))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('inspection templates', cb),
  )
}

export async function addTemplate(orgId, data, actor) {
  const ref = await addDoc(templateCol(orgId), {
    ...data,
    assignments: data.assignments || [],
    createdBy: actor?.name || '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  await logAudit(orgId, actor, 'template.create', {
    targetId: ref.id,
    targetLabel: data.title || '',
    summary: `Created inspection form "${data.title}"`,
  })
  return ref.id
}

export async function updateTemplate(orgId, id, updates, actor) {
  await updateDoc(templateRef(orgId, id), { ...updates, updatedAt: serverTimestamp() })
  await logAudit(orgId, actor, 'template.update', {
    targetId: id,
    targetLabel: updates.title || '',
    summary: `Updated inspection form`,
  })
}

export async function setTemplateStatus(orgId, id, status) {
  await updateDoc(templateRef(orgId, id), { status, updatedAt: serverTimestamp() })
}

/**
 * Set the status of ONE assignment, leaving the rest as found.
 *
 * Pure, so the merge can be tested without Firestore.
 */
export function applyAssignmentStatus(assignments, assignmentId, status) {
  let found = false
  const next = (assignments || []).map((a) => {
    if (a?.id !== assignmentId) return a
    found = true
    return { ...a, status }
  })
  return { assignments: next, found }
}

/**
 * Mark an assignment Completed once its inspection has been recorded.
 *
 * Nothing ever did this. The only statuses written were Pending and Cancelled,
 * so submitting an assigned inspection left the assignment Pending forever: it
 * stayed on the schedule and kept rolling into overdueTasks, which is the list
 * people work from. Recurring assignments were saved by the pastRecords check
 * in schedule.js; the one-off branch had no record check at all.
 *
 * A transaction because assignments live as an ARRAY on the template document.
 * Writing the array back from the copy this screen was holding would revert
 * anything the scheduler modal had changed since — the same defect the HIRA
 * action tracker had, in a different module.
 *
 * Never throws: the inspection RECORD is the thing that matters and it has
 * already landed. Failing the submit because its bookkeeping could not be
 * updated would lose the work; schedule.js now drops a completed one-off on the
 * record alone, so this is the tidy-up and not the guarantee.
 */
export async function completeAssignment(orgId, templateId, assignmentId) {
  if (!orgId || !templateId || !assignmentId) return false
  try {
    return await runTransaction(db, async (tx) => {
      const ref = templateRef(orgId, templateId)
      const snap = await tx.get(ref)
      if (!snap.exists()) return false
      const { assignments, found } = applyAssignmentStatus(
        snap.data().assignments || [], assignmentId, 'Completed',
      )
      if (!found) return false
      tx.update(ref, { assignments, updatedAt: serverTimestamp() })
      return true
    })
  } catch (e) {
    reportError(e, { source: 'inspections.completeAssignment', orgId, templateId })
    return false
  }
}

/** Replace the assignments array on a template (used by the scheduler modal). */
export async function updateTemplateAssignments(orgId, id, assignments, actor) {
  await updateDoc(templateRef(orgId, id), { assignments, updatedAt: serverTimestamp() })
  await logAudit(orgId, actor, 'assignment.update', {
    targetId: id,
    summary: `Updated assignments (${assignments.length})`,
  })
}

export async function deleteTemplate(orgId, id, label, actor) {
  await deleteDoc(templateRef(orgId, id))
  await logAudit(orgId, actor, 'template.delete', {
    targetId: id,
    targetLabel: label || '',
    summary: `Deleted inspection form "${label}"`,
  })
}

// ── Inspection records (completed inspections) ───────────────────────────────────

export function subscribeRecords(orgId, cb) {
  const q = query(recordCol(orgId), orderBy('completedAt', 'desc'), limit(500))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('inspection records', cb),
  )
}

export async function addRecord(orgId, record, actor) {
  const ref = await addDoc(recordCol(orgId), {
    docId: await reserveDocId(orgId, 'inspections'),
    ...record,
    completedAt: record.completedAt || new Date().toISOString(),
    createdAt: serverTimestamp(),
  })
  await logAudit(orgId, actor, 'inspection.submit', {
    target: 'record',
    targetId: ref.id,
    targetLabel: record.templateTitle || '',
    summary: `Submitted "${record.templateTitle}" — ${record.score}% (${record.passFailResult})`,
  })
  return ref.id
}

export async function deleteRecord(orgId, id, label, actor) {
  await deleteDoc(recordRef(orgId, id))
  await logAudit(orgId, actor, 'record.delete', {
    target: 'record',
    targetId: id,
    targetLabel: label || '',
    summary: `Deleted inspection record`,
  })
}

// ── Sites (admin-managed) ────────────────────────────────────────────────────────

// Delegated to the shared ref-counted org-sites listener (one per org app-wide).
export { subscribeSites } from '../../../shared/org/orgData'
