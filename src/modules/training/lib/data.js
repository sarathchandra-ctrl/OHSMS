// ─────────────────────────────────────────────────────────────────────────────
// Training & Certifications data layer. Org-scoped collections:
//   organizations/{orgId}/trainingCourses  — the course catalogue
//   organizations/{orgId}/trainingRecords  — one record per employee completion
// Every mutation writes to the shared append-only audit log (module 'training').
// ─────────────────────────────────────────────────────────────────────────────
import {
  addDoc, deleteDoc, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, serverTimestamp,
  updateDoc, where, writeBatch, collection,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { logAudit } from '../../../shared/org/orgData'
import { isPermissionDenied } from '../../../shared/lib/permissionDenied'
import { computeExpiry, todayISO } from './status'
import { reserveDocId } from '../../../shared/docId/reserve'
import { removeFile } from '../../../shared/storage'

const courseCol = () => collection(db, 'trainingCourses')
const courseRef = (id) => doc(db, 'trainingCourses', id)
const recordCol = () => collection(db, 'trainingRecords')
const recordRef = (id) => doc(db, 'trainingRecords', id)
const assignmentCol = () => collection(db, 'trainingAssignments')
const assignmentRef = (id) => doc(db, 'trainingAssignments', id)
// Classroom sittings of a course, and the employees asking for a place on one.
const sessionCol = () => collection(db, 'trainingSessions')
const sessionRef = (id) => doc(db, 'trainingSessions', id)
const requestCol = () => collection(db, 'trainingRequests')
const requestRef = (id) => doc(db, 'trainingRequests', id)

export const COURSE_CATEGORIES = [
  'Induction', 'Fire Safety', 'First Aid', 'Work at Height', 'Electrical Safety',
  'LOTO', 'Chemical Handling', 'Confined Space', 'Emergency Response',
  'Manual Handling', 'PPE', 'Statutory', 'Refresher', 'Other',
]

// ── Subscriptions ─────────────────────────────────────────────────────────────
export function subscribeCourses(cb) {
  const q = query(courseCol(), orderBy('name'))
  return onSnapshot(q, (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))), () => cb([]))
}
// Live streams are bounded (most-recent first) so app start stays fast at
// thousands of employees; full history is fetched on demand for reports.
export const RECORDS_LIVE_CAP = 2500
export const ASSIGNMENTS_LIVE_CAP = 5000

export function subscribeRecords(cb) {
  const q = query(recordCol(), orderBy('completedOn', 'desc'), limit(RECORDS_LIVE_CAP))
  return onSnapshot(q, (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))), () => cb([]))
}
/**
 * Live training assignments with the read's status.
 *
 * The array-only wrapper below still emits [] on a failed read, because the
 * training module treats that as "none yet". The portal home cannot: that []
 * used to render as "nothing outstanding" while the listener had actually
 * been refused. Home uses this form and stays in loading unless status is 'ok'.
 */
export function subscribeAssignmentsRead(cb) {
  const q = query(assignmentCol(), orderBy('createdAt', 'desc'), limit(ASSIGNMENTS_LIVE_CAP))
  return onSnapshot(
    q,
    (s) => cb({ rows: s.docs.map((d) => ({ id: d.id, ...d.data() })), status: 'ok' }),
    (err) => cb({ rows: [], status: isPermissionDenied(err) ? 'denied' : 'failed' })
  )
}
export function subscribeAssignments(cb) {
  return subscribeAssignmentsRead(({ rows }) => cb(rows))
}

/** One-time full fetches for reports (CSV) — not subject to the live caps. */
export async function fetchAllRecords() {
  const s = await getDocs(query(recordCol(), orderBy('completedOn', 'desc')))
  return s.docs.map((d) => ({ id: d.id, ...d.data() }))
}
export async function fetchAllAssignments() {
  const s = await getDocs(assignmentCol())
  return s.docs.map((d) => ({ id: d.id, ...d.data() }))
}

// ── Courses ───────────────────────────────────────────────────────────────────
// Course content items: learning material shown in "My Learning".
const cleanContent = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((c) => c && (c.label || '').trim() && (c.url || c.dataUrl))
    .map((c) => ({
      id: c.id || `ct-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      type: c.type === 'file' ? 'file' : 'link',
      label: c.label.trim(),
      url: c.url || '',
      // Cloud-storage location; legacy items keep their inline dataUrl instead.
      path: c.path || '',
      fileName: c.fileName || '',
      dataUrl: c.dataUrl || '',
    }))

const cleanCourse = (data) => ({
  name: (data.name || '').trim(),
  category: data.category || 'Other',
  // Courses created before sessions existed carry no mode; they are self-paced
  // material, which is what 'module' means, so the default is the truth rather
  // than a placeholder.
  deliveryMode: data.deliveryMode === 'classroom' ? 'classroom' : 'module',
  validityMonths: Number(data.validityMonths) || 0, // 0 = never expires
  mandatory: !!data.mandatory,
  description: (data.description || '').trim(),
  content: cleanContent(data.content),
  thumbnail: data.thumbnail || '', // data-URL (legacy) or cloud URL for the course card
  thumbnailPath: data.thumbnailPath || '',
})

export async function createCourse(data, actor) {
  const ref = await addDoc(courseCol(), {
    ...cleanCourse(data),
    docId: await reserveDocId('training'),
    createdAt: serverTimestamp(),
    createdBy: actor?.uid || null,
    createdByName: actor?.name || '',
  })
  await logAudit(actor, 'training.course_create', {
    module: 'training', target: 'course', targetId: ref.id, targetLabel: data.name,
    summary: `Created course "${data.name}"`,
  })
  return ref.id
}

export async function updateCourse(id, data, actor) {
  await updateDoc(courseRef(id), { ...cleanCourse(data), updatedAt: serverTimestamp() })
  await logAudit(actor, 'training.course_update', {
    module: 'training', target: 'course', targetId: id, targetLabel: data.name,
    summary: `Updated course "${data.name}"`,
  })
}

export async function deleteCourse(id, actor, label) {
  // Content files live in cloud storage; deleting only the document would
  // strand them. Best-effort and before the delete, because afterwards nothing
  // remembers the paths. A failure here costs storage, not correctness.
  try {
    const snap = await getDoc(courseRef(id))
    for (const c of snap.data()?.content || []) {
      if (c.path) removeFile(c.path)
    }
    if (snap.data()?.thumbnailPath) removeFile(snap.data().thumbnailPath)
  } catch { /* orphans tolerated */ }
  await deleteDoc(courseRef(id))
  await logAudit(actor, 'training.course_delete', {
    module: 'training', target: 'course', targetId: id, targetLabel: label,
    summary: `Deleted course "${label}"`,
  })
}

// ── Records ───────────────────────────────────────────────────────────────────
// One training session for N employees → N records (individual certification
// lifecycles), written in a single batch. Any matching OPEN assignments (same
// course + employee, passed in from the live context) are completed too.
export async function logTraining({ course, employees, trainerName, completedOn, scope, notes }, actor, openAssignments = []) {
  const expiresOn = computeExpiry(completedOn, course.validityMonths)
  const uids = new Set(employees.map((e) => e.uid))
  const matching = openAssignments.filter(
    (a) => a.status === 'assigned' && a.courseId === course.id && uids.has(a.employeeUid),
  )
  // ── Chunked, like both of its neighbours in this file ──────────────────────
  //
  // This was ONE writeBatch holding matching.length + employees.length
  // operations. Firestore rejects a batch over 500 outright, so a site-wide
  // induction — the exact case this screen exists for — failed wholesale, and
  // failed harder the more people had attended. assignCourse and cancelCourse
  // directly below have chunked at 400 all along; this one was the odd one out.
  //
  // The two write kinds go into one queue so a chunk boundary can fall
  // anywhere: splitting them separately would leave the assignment updates in
  // one batch and the records in another for no benefit, since neither half is
  // atomic with the other regardless.
  const writes = [
    ...matching.map((a) => (batch) =>
      batch.update(assignmentRef(a.id), { status: 'completed', completedOn })),
    ...employees.map((emp) => (batch) =>
      batch.set(doc(recordCol()), {
        courseId: course.id,
        courseName: course.name,
        category: course.category || 'Other',
        validityMonths: Number(course.validityMonths) || 0,
        employeeUid: emp.uid,
        employeeName: emp.name || emp.email || 'Unknown',
        trainerName: (trainerName || '').trim(),
        completedOn,
        expiresOn,
        region: scope?.region || '',
        entity: scope?.entity || '',
        siteId: scope?.siteId || '',
        site: scope?.site || '',
        notes: (notes || '').trim(),
        createdAt: serverTimestamp(),
        createdBy: actor?.uid || null,
        createdByName: actor?.name || '',
      })),
  ]
  for (let i = 0; i < writes.length; i += 400) {
    const batch = writeBatch(db)
    for (const apply of writes.slice(i, i + 400)) apply(batch)
    await batch.commit()
  }
  await logAudit(actor, 'training.record_create', {
    module: 'training', target: 'record', targetLabel: course.name,
    summary: `Logged "${course.name}" for ${employees.length} employee(s)`,
  })
  return employees.length
}

export async function deleteRecord(id, actor, label) {
  await deleteDoc(recordRef(id))
  await logAudit(actor, 'training.record_delete', {
    module: 'training', target: 'record', targetId: id, targetLabel: label,
    summary: `Deleted training record${label ? ` "${label}"` : ''}`,
  })
}

// ── Assignments (LMS) ─────────────────────────────────────────────────────────

/**
 * Assign a course to employees with a due date — one assignment per employee,
 * skipping anyone who already has an OPEN assignment for that course. `group`
 * ({ mode, label }) stamps every doc so the Admin Workspace can show the batch
 * as one campaign (e.g. "Department: Safety"). Returns { assigned, skipped }.
 */
export async function assignCourse({ course, employees, dueDate, group }, actor, openAssignments = []) {
  const alreadyOpen = new Set(
    openAssignments
      .filter((a) => a.status === 'assigned' && a.courseId === course.id)
      .map((a) => a.employeeUid),
  )
  const targets = employees.filter((e) => !alreadyOpen.has(e.uid))
  const batchId = `asn-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  if (targets.length) {
    // Group assignments (a whole department/site/entity) can exceed the 500-op
    // Firestore batch limit — chunk the writes.
    for (let i = 0; i < targets.length; i += 400) {
      const batch = writeBatch(db)
      for (const emp of targets.slice(i, i + 400)) {
        batch.set(doc(assignmentCol()), {
          courseId: course.id,
          courseName: course.name,
          category: course.category || 'Other',
          employeeUid: emp.uid,
          employeeName: emp.name || emp.email || 'Unknown',
          dueDate: dueDate || '',
          status: 'assigned',
          batchId,
          groupMode: group?.mode || 'people',
          groupLabel: group?.label || 'Individual selection',
          assignedBy: actor?.uid || null,
          assignedByName: actor?.name || '',
          createdAt: serverTimestamp(),
        })
      }
      await batch.commit()
    }
    await logAudit(actor, 'training.assign', {
      module: 'training', target: 'assignment', targetLabel: course.name,
      summary: `Assigned "${course.name}" to ${targets.length} employee(s)${group?.label ? ` (${group.label})` : ''}${dueDate ? `, due ${dueDate}` : ''}`,
    })
  }
  return { assigned: targets.length, skipped: employees.length - targets.length, batchId }
}

/** Cancel many open assignments at once (whole campaign), chunked. */
export async function cancelAssignmentsBulk(ids, actor, label) {
  for (let i = 0; i < ids.length; i += 400) {
    const batch = writeBatch(db)
    for (const id of ids.slice(i, i + 400)) batch.update(assignmentRef(id), { status: 'cancelled' })
    await batch.commit()
  }
  await logAudit(actor, 'training.assign_cancel', {
    module: 'training', target: 'assignment', targetLabel: label || '',
    summary: `Cancelled ${ids.length} open assignment(s)${label ? ` — ${label}` : ''}`,
  })
}

export async function cancelAssignment(id, actor, label) {
  await updateDoc(assignmentRef(id), { status: 'cancelled' })
  await logAudit(actor, 'training.assign_cancel', {
    module: 'training', target: 'assignment', targetId: id, targetLabel: label,
    summary: `Cancelled assignment${label ? ` "${label}"` : ''}`,
  })
}

/**
 * Learner self-completion from "My Learning": creates the training record
 * (flagged loggedBy 'self') and closes the employee's open assignment(s) for
 * the course, atomically.
 */
export async function selfCompleteTraining({ course, profile, assignmentIds = [] }, actor) {
  const completedOn = todayISO()
  const expiresOn = computeExpiry(completedOn, course.validityMonths)
  const batch = writeBatch(db)
  const rref = doc(recordCol())
  batch.set(rref, {
    courseId: course.id,
    courseName: course.name,
    category: course.category || 'Other',
    validityMonths: Number(course.validityMonths) || 0,
    employeeUid: profile.uid,
    employeeName: profile.name || profile.email || 'Unknown',
    trainerName: '',
    completedOn,
    expiresOn,
    region: '', entity: '', siteId: '', site: '',
    notes: '',
    loggedBy: 'self',
    createdAt: serverTimestamp(),
    createdBy: profile.uid,
    createdByName: profile.name || '',
  })
  for (const id of assignmentIds) {
    batch.update(assignmentRef(id), { status: 'completed', completedOn, recordId: rref.id })
  }
  await batch.commit()
  await logAudit(actor, 'training.self_complete', {
    module: 'training', target: 'record', targetId: rref.id, targetLabel: course.name,
    summary: `Self-completed "${course.name}"`,
  })
  return rref.id
}

// ── Classroom sessions ────────────────────────────────────────────────────────
// A session is one sitting of a classroom course: a window it runs in, and
// either a link to join or a site to attend. Courses can have several.

const cleanSession = (d) => ({
  courseId: d.courseId || '',
  courseName: (d.courseName || '').trim(),
  mode: d.mode === 'offline' ? 'offline' : 'online',
  // Only the field the mode actually uses is stored, so switching mode cannot
  // leave a stale link pointing at a room or a room attached to a video call.
  meetingLink: d.mode === 'offline' ? '' : (d.meetingLink || '').trim(),
  siteId: d.mode === 'offline' ? d.siteId || '' : '',
  siteName: d.mode === 'offline' ? (d.siteName || '').trim() : '',
  room: d.mode === 'offline' ? (d.room || '').trim() : '',
  validFrom: d.validFrom || '',
  validTo: d.validTo || '',
  trainerName: (d.trainerName || '').trim(),
  seats: Number(d.seats) > 0 ? Number(d.seats) : 0, // 0 = no cap
  notes: (d.notes || '').trim(),
})

export function subscribeSessions(cb) {
  return onSnapshot(
    query(sessionCol(), orderBy('validFrom', 'desc')),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    () => cb([]),
  )
}

export async function createSession(data, actor) {
  const s = cleanSession(data)
  const ref = await addDoc(sessionCol(), {
    ...s,
    docId: await reserveDocId('trainingSessions'),
    createdAt: serverTimestamp(),
    createdBy: actor?.uid || null,
  })
  await logAudit(actor, 'training.session_create', {
    module: 'training', target: 'session', targetId: ref.id, targetLabel: s.courseName,
    summary: `Scheduled "${s.courseName}" ${s.mode === 'online' ? 'online' : `at ${s.siteName || 'a site'}`} (${s.validFrom} → ${s.validTo})`,
  })
  return ref.id
}

export async function updateSession(id, data, actor) {
  const s = cleanSession(data)
  await updateDoc(sessionRef(id), { ...s, updatedAt: serverTimestamp() })
  await logAudit(actor, 'training.session_update', {
    module: 'training', target: 'session', targetId: id, targetLabel: s.courseName,
    summary: `Updated session for "${s.courseName}"`,
  })
}

/**
 * Delete a session and every request against it.
 *
 * Leaving the requests behind would strand them: they point at a session that
 * no longer exists, so nobody could act on them and the employee would still
 * appear to be waiting.
 */
export async function deleteSession(id, actor, label) {
  const reqs = await getDocs(query(requestCol(), where('sessionId', '==', id)))
  const batch = writeBatch(db)
  batch.delete(sessionRef(id))
  reqs.docs.forEach((d) => batch.delete(d.ref))
  await batch.commit()
  await logAudit(actor, 'training.session_delete', {
    module: 'training', target: 'session', targetId: id, targetLabel: label || '',
    summary: `Deleted session${label ? ` for "${label}"` : ''}${reqs.size ? ` and ${reqs.size} request(s)` : ''}`,
  })
}

// ── Requests for a place ──────────────────────────────────────────────────────

export function subscribeRequests(cb) {
  return onSnapshot(
    query(requestCol(), orderBy('createdAt', 'desc')),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    () => cb([]),
  )
}

/**
 * Ask for a place on a session. Idempotent per person: asking twice re-opens
 * the existing request rather than adding a second, so an admin's count is
 * people wanting the training and not clicks.
 */
export async function requestSession({ session, profile }, actor) {
  const existing = await getDocs(query(
    requestCol(),
    where('sessionId', '==', session.id),
    where('employeeUid', '==', profile?.uid || ''),
  ))
  if (!existing.empty) {
    await updateDoc(existing.docs[0].ref, { status: 'pending', updatedAt: serverTimestamp() })
    return existing.docs[0].id
  }
  const ref = await addDoc(requestCol(), {
    sessionId: session.id,
    courseId: session.courseId || '',
    courseName: session.courseName || '',
    employeeUid: profile?.uid || '',
    employeeName: profile?.name || profile?.email || 'Unknown',
    employeeEmail: profile?.email || '',
    siteId: profile?.siteId || '',
    status: 'pending',
    createdAt: serverTimestamp(),
  })
  await logAudit(actor, 'training.session_request', {
    module: 'training', target: 'request', targetId: ref.id, targetLabel: session.courseName || '',
    summary: `${profile?.name || 'An employee'} requested a place on "${session.courseName}"`,
  })
  return ref.id
}

export async function withdrawRequest(id, actor, label) {
  await deleteDoc(requestRef(id))
  await logAudit(actor, 'training.session_request_withdraw', {
    module: 'training', target: 'request', targetId: id, targetLabel: label || '',
    summary: `Withdrew request for "${label || 'a session'}"`,
  })
}

export async function decideRequest(request, status, actor) {
  await updateDoc(requestRef(request.id), {
    status, reviewedBy: actor?.name || '', reviewedAt: serverTimestamp(),
  })
  await logAudit(actor, 'training.session_request_decide', {
    module: 'training', target: 'request', targetId: request.id, targetLabel: request.courseName || '',
    summary: `${status === 'approved' ? 'Approved' : 'Declined'} ${request.employeeName}'s request for "${request.courseName}"`,
  })
}
