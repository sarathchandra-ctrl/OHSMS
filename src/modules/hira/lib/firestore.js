// ─────────────────────────────────────────────────────────────────────────────
// All Firestore access goes through here. Org-scoped paths:
//   organizations/{orgId}                          — org doc
//   organizations/{orgId}/assessments/{id}         — risk assessments
//   users/{uid}                                    — user profiles
//   orgIndex/{slug}                                — public name→org index (signup)
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
  writeBatch,
  runTransaction,
  limit,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { isSessionEnd } from '../../../shared/sessionEnd'
import { isPermissionDenied } from '../../../shared/lib/permissionDenied'
import { reserveDocId, reserveDocIds } from '../../../shared/docId/reserve'

// ── Path helpers ─────────────────────────────────────────────────────────────
const orgRef = (orgId) => doc(db, 'organizations', orgId)
const assessmentCol = (orgId) => collection(db, 'organizations', orgId, 'assessments')
const assessmentRef = (orgId, id) => doc(db, 'organizations', orgId, 'assessments', id)

// ── Organizations & users ─────────────────────────────────────────────────────

// Default snapshot error handler: log a warning instead of letting Firestore
// raise an "Uncaught Error in snapshot listener" that can hang/blank the UI.
const onSnapErr = (label) => (err) => {
  if (isSessionEnd(label, err) || isPermissionDenied(err)) return
  // eslint-disable-next-line no-console
  console.warn(`[HIRA] ${label} listener error:`, err?.code || err?.message || err)
}

// Delegated to the shared ref-counted org-users listener (one per org app-wide).
export { subscribeOrgUsers } from '../../../shared/org/orgData'

/** Live org document (name, address, sites, …). */
export function subscribeOrg(orgId, cb, onError) {
  return onSnapshot(orgRef(orgId), (snap) => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null), onError || onSnapErr('org'))
}

// ── Activity log (append-only audit trail) ────────────────────────────────────
const activityCol = (orgId) => collection(db, 'organizations', orgId, 'activity')

/** Record a user action. Fire-and-forget — never blocks the main operation. */
export function logActivity(orgId, actor, { type, message, assessmentId = null }) {
  if (!orgId) return
  addDoc(activityCol(orgId), {
    type: type || 'event',
    message: message || '',
    assessmentId,
    actorUid: actor?.uid || null,
    actorName: actor?.name || 'Someone',
    at: serverTimestamp(),
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn('[HIRA] activity log failed:', e?.message || e)
  })
}

export function subscribeActivity(orgId, cb, onError, max = 50) {
  const q = query(activityCol(orgId), orderBy('at', 'desc'), limit(max))
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onError || onSnapErr('activity'))
}

// ── Risk assessments ──────────────────────────────────────────────────────────

const ASSESSMENT_LOAD_CAP = 1000

export function subscribeAssessments(orgId, cb, onError, max = ASSESSMENT_LOAD_CAP) {
  const q = query(assessmentCol(orgId), orderBy('createdAt', 'desc'), limit(max))
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onError || onSnapErr('assessments'))
}

/** Strip undefined values so Firestore accepts the nested write. */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = clean(v)
    }
    return out
  }
  return value
}

export async function createAssessment(orgId, data, actor) {
  const ref = await addDoc(assessmentCol(orgId), {
    ...clean(data),
    docId: await reserveDocId(orgId, 'hira'),
    createdBy: actor?.uid || null,
    createdByName: actor?.name || '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return ref.id
}

export async function updateAssessment(orgId, id, data) {
  await updateDoc(assessmentRef(orgId, id), {
    ...clean(data),
    updatedAt: serverTimestamp(),
  })
}

/**
 * Apply `patch` to ONE additional control, leaving everything else exactly as
 * it was found.
 *
 * Pure, so the merge can be tested without Firestore — which is most of the
 * point, because what goes wrong here is silent and the transaction below is
 * only ever as good as this.
 *
 * Throws when the control is not there. A patch that quietly matches nothing
 * reports success to somebody who has just marked an action complete, and the
 * action stays open.
 */
export function applyControlPatch(activities, locator, patch) {
  let found = false
  const next = (activities || []).map((act) =>
    act.id !== locator.activityId
      ? act
      : {
          ...act,
          hazards: (act.hazards || []).map((h) =>
            h.id !== locator.hazardId
              ? h
              : {
                  ...h,
                  additionalControls: (h.additionalControls || []).map((c) => {
                    if (c.id !== locator.controlId) return c
                    found = true
                    return { ...c, ...patch }
                  }),
                },
          ),
        },
  )
  if (!found) {
    throw new Error('That action is no longer on this assessment — it may have been removed.')
  }
  return next
}

/**
 * Set a field on one additional control, inside a transaction.
 *
 * The Action Tracker used to rebuild the whole `activities` array from the row
 * it was rendering and hand it to updateAssessment — so marking a single
 * control Implemented wrote back every activity, hazard and control of that
 * assessment as it looked when the snapshot arrived. Anyone editing the same
 * assessment at that moment had their work reverted: a hazard added in
 * CreateAssessment, another tracker user closing a different action. On a risk
 * register a hazard could disappear outright, with nothing in the audit trail
 * and nothing on screen to suggest it had.
 *
 * Re-reading inside the transaction is what makes the write a patch rather
 * than a replacement. It costs one document read per status change, which is
 * the price of not overwriting a colleague.
 */
export async function patchAdditionalControl(orgId, id, locator, patch) {
  const ref = assessmentRef(orgId, id)
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('That assessment no longer exists.')
    tx.update(ref, {
      activities: applyControlPatch(snap.data().activities || [], locator, patch),
      updatedAt: serverTimestamp(),
    })
  })
}

export async function deleteAssessment(orgId, id) {
  await deleteDoc(assessmentRef(orgId, id))
}

/** Bulk create assessments (from CSV import) in chunked batches. `kind` marks
 *  the imported rows as 'site' (normal) or 'baseline' (activity template). */
export async function bulkCreateAssessments(orgId, list, actor, kind = 'site') {
  // Every imported assessment gets a reference, exactly as createAssessment
  // gives one to every assessment raised through the form.
  //
  // The bulk path did not, so a CSV import produced rows that were blank in
  // every list, every export and every printed PDF — the identifier people
  // quote to an auditor, missing from precisely the records that arrived in
  // bulk. One transaction for the whole import rather than one per row: two
  // hundred reservations against the same counter would each retry against the
  // last.
  const ids = await reserveDocIds(orgId, 'hira', list.length)
  let created = 0
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200)
    const batch = writeBatch(db)
    chunk.forEach((data, j) => {
      const ref = doc(assessmentCol(orgId))
      batch.set(ref, {
        ...clean(data),
        docId: ids[i + j],
        kind,
        baselineId: '',
        createdBy: actor?.uid || null,
        createdByName: actor?.name || '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      created++
    })
    await batch.commit()
  }
  return created
}
