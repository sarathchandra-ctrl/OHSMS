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
const templateCol = () => collection(db, 'inspectionTemplates')
const templateRef = (id) => doc(db, 'inspectionTemplates', id)
const recordCol = () => collection(db, 'inspectionRecords')
const recordRef = (id) => doc(db, 'inspectionRecords', id)

// ── Audit log ────────────────────────────────────────────────────────────────
// One implementation, in shared/org/orgData; this wrapper adds only the module
// key and the default target. The private copy it replaces omitted both
// `module` and `source`, so inspection entries read as "Core" in the unified
// Audit Log with no origin recorded.
const logAudit = (actor, action, details = {}) =>
  logOrgAudit(actor, action, { module: 'inspections', target: 'template', ...details })

// ── Organizations & users ──────────────────────────────────────────────────────

// Delegated to the shared ref-counted org-users listener (one per org app-wide).
export { subscribeOrgUsers } from '../../../shared/org/orgData'

// ── Inspection templates ───────────────────────────────────────────────────────

export function subscribeTemplates(cb) {
  // The only uncapped listener left in this module, and templates carry their
  // whole `fields` AND `assignments` arrays — so it is also the heaviest.
  const q = query(templateCol(), orderBy('createdAt', 'desc'), limit(COLLECTION_READ_CAP))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('inspection templates', cb),
  )
}

export async function addTemplate(data, actor) {
  const ref = await addDoc(templateCol(), {
    ...data,
    assignments: data.assignments || [],
    createdBy: actor?.name || '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  await logAudit(actor, 'template.create', {
    targetId: ref.id,
    targetLabel: data.title || '',
    summary: `Created inspection form "${data.title}"`,
  })
  return ref.id
}

export async function updateTemplate(id, updates, actor) {
  await updateDoc(templateRef(id), { ...updates, updatedAt: serverTimestamp() })
  await logAudit(actor, 'template.update', {
    targetId: id,
    targetLabel: updates.title || '',
    summary: `Updated inspection form`,
  })
}

export async function setTemplateStatus(id, status) {
  await updateDoc(templateRef(id), { status, updatedAt: serverTimestamp() })
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
export async function completeAssignment(templateId, assignmentId) {
  if (!templateId || !assignmentId) return false
  try {
    return await runTransaction(db, async (tx) => {
      const ref = templateRef(templateId)
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
    reportError(e, { source: 'inspections.completeAssignment', templateId })
    return false
  }
}

/** Replace the assignments array on a template (used by the scheduler modal). */
export async function updateTemplateAssignments(id, assignments, actor) {
  await updateDoc(templateRef(id), { assignments, updatedAt: serverTimestamp() })
  await logAudit(actor, 'assignment.update', {
    targetId: id,
    summary: `Updated assignments (${assignments.length})`,
  })
}

export async function deleteTemplate(id, label, actor) {
  await deleteDoc(templateRef(id))
  await logAudit(actor, 'template.delete', {
    targetId: id,
    targetLabel: label || '',
    summary: `Deleted inspection form "${label}"`,
  })
}

// ── Inspection records (completed inspections) ───────────────────────────────────

export function subscribeRecords(cb) {
  const q = query(recordCol(), orderBy('completedAt', 'desc'), limit(500))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('inspection records', cb),
  )
}

export async function addRecord(record, actor) {
  const ref = await addDoc(recordCol(), {
    docId: await reserveDocId('inspections'),
    ...record,
    completedAt: record.completedAt || new Date().toISOString(),
    createdAt: serverTimestamp(),
  })
  await logAudit(actor, 'inspection.submit', {
    target: 'record',
    targetId: ref.id,
    targetLabel: record.templateTitle || '',
    summary: `Submitted "${record.templateTitle}" — ${record.score}% (${record.passFailResult})`,
  })
  return ref.id
}

export async function deleteRecord(id, label, actor) {
  await deleteDoc(recordRef(id))
  await logAudit(actor, 'record.delete', {
    target: 'record',
    targetId: id,
    targetLabel: label || '',
    summary: `Deleted inspection record`,
  })
}

// ── Sites (admin-managed) ────────────────────────────────────────────────────────

// Delegated to the shared ref-counted org-sites listener (one per org app-wide).
export { subscribeSites } from '../../../shared/org/orgData'
