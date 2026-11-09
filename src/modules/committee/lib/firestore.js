// ─────────────────────────────────────────────────────────────────────────────
// All Firestore access goes through here: org/user management (the auth +
// admin-approval workflow) plus the org-scoped consultation meetings and sites.
// ─────────────────────────────────────────────────────────────────────────────
import {
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  deleteDoc,
  onSnapshot,
  query,
  limit,
  serverTimestamp,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { isSessionEnd } from '../../../shared/sessionEnd'
import { isPermissionDenied } from '../../../shared/lib/permissionDenied'
import { reserveDocId } from '../../../shared/docId/reserve'
import { orgIndexRef, COLLECTION_READ_CAP } from '../../../shared/org/orgData'
// Minutes name people and record what was said about them, so the subject, the
// body, the attendee list and the action owners are sealed under the GENERAL
// class — every approved member may read a meeting record, so the key follows.
// What stays readable is what the calendar and the site filter group by: type,
// date, siteId, docId.
import { sealDoc, openSnapshots } from '../../../shared/crypto'
import { reportError } from '../../../shared/monitoring'
import { discardMailedReport } from '../../../shared/print/mailedReport'

/** The policy key for this collection. See src/shared/crypto/policy.js. */
const SEALED = 'consultations'

// ── Path helpers ─────────────────────────────────────────────────────────────
const consultationCol = (orgId) => collection(db, 'organizations', orgId, 'consultations')
const consultationRef = (orgId, id) => doc(db, 'organizations', orgId, 'consultations', id)
// Public, minimal name→org index so signup can look up an org by name WITHOUT
// reading the (member-only) organizations collection.
// orgIndexRef comes from shared/org/orgData — this file used to carry a
// byte-identical private copy.

// ── Organizations & users ─────────────────────────────────────────────────────

/**
 * Backfill the public orgIndex entry for an org if it's missing. Idempotent +
 * non-blocking (the index is a convenience for signup, never critical).
 */
export async function ensureOrgIndex(org) {
  if (!org?.id || !org?.name) return
  try {
    const ref = orgIndexRef(org.name)
    const snap = await getDoc(ref)
    if (snap.exists()) return
    await setDoc(ref, { orgId: org.id, name: org.name })
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[HSE] orgIndex backfill skipped:', e?.message || e)
  }
}

// Delegated to the shared ref-counted org-users listener (one per org app-wide).
export { subscribeOrgUsers } from '../../../shared/org/orgData'

// ── Sites (organizations/{orgId}/sites) ────────────────────────────────────────
// Facility sites the committee meetings are scoped/filtered by. { code, name }.

// Delegated to the shared ref-counted org-sites listener (one per org app-wide).
export { subscribeSites } from '../../../shared/org/orgData'

// ── Consultations / meetings (organizations/{orgId}/consultations) ──────────────

export function subscribeConsultations(orgId, cb, onError) {
  // openSnapshots drops any batch that is no longer the latest — decryption is
  // async and this listener has no orderBy, so a re-emission can overtake the
  // batch before it and put an older list on screen.
  const opened = openSnapshots(orgId, SEALED, cb)
  // Capped: minutes accumulate for the life of the organization and nothing
  // ever removes them, so this is the collection most certain to grow without
  // bound. No orderBy, deliberately — see subscribeCollections in orgData.
  return onSnapshot(
    query(consultationCol(orgId), limit(COLLECTION_READ_CAP)),
    (snap) => opened(snap.docs.map((d) => ({ firebaseKey: d.id, ...d.data() }))),
    (err) => {
      if (!isSessionEnd('consultations', err) && !isPermissionDenied(err)) {
        // eslint-disable-next-line no-console
        console.warn('[HSE] consultations read failed:', err?.message || err)
      }
      onError?.(err)
    }
  )
}

function hasMinutes(data) {
  return typeof data?.minutes === 'string' && data.minutes.trim().length > 0
}

async function meetingSiteLabel(orgId, siteId) {
  if (!siteId) return '—'
  try {
    const snap = await getDoc(doc(db, 'organizations', orgId, 'sites', siteId))
    return snap.exists() ? snap.data()?.name || siteId : siteId
  } catch {
    return siteId
  }
}

// The mail fires on the write that first stores minutes. The PDF has to be in
// Storage before that write, named on the document, or the function attaches
// nothing. A later edit of minutes that are already there is not a second mail,
// so it does not upload another copy.
async function mailedMeetingPdf(orgId, meeting) {
  if (typeof document === 'undefined' || !hasMinutes(meeting)) return ''
  try {
    const { captureMeetingReport } = await import('./meetingReportPdf.js')
    const siteLabel = await meetingSiteLabel(orgId, meeting.siteId)
    return await captureMeetingReport(orgId, meeting, siteLabel)
  } catch (e) {
    reportError(e, { source: 'committee.mailedMeetingPdf', orgId })
    return ''
  }
}

export async function addConsultation(orgId, data) {
  const docId = data.docId || (await reserveDocId(orgId, 'committee'))
  const plain = { ...data, docId }
  const reportPdfPath = await mailedMeetingPdf(orgId, plain)
  if (reportPdfPath) plain.reportPdfPath = reportPdfPath
  const ref = await addDoc(consultationCol(orgId), {
    ...(await sealDoc(orgId, SEALED, plain)),
    // Sealed AFTER the spread so these two cannot be overwritten by a caller's
    // payload, and outside it because neither is in the policy: docId is the
    // org-wide reference the calendar and the printed minutes quote, and
    // createdAt is a write sentinel with no plaintext to seal.
    docId,
    createdAt: serverTimestamp(),
  })
  return ref.id
}

export async function updateConsultation(orgId, id, data) {
  const plain = { ...data }
  if (hasMinutes(plain)) {
    let prior = false
    try {
      const prev = await getDoc(consultationRef(orgId, id))
      prior = hasMinutes(prev.data())
    } catch (e) {
      reportError(e, { source: 'committee.updateConsultation.prior', orgId })
    }
    if (!prior) {
      const reportPdfPath = await mailedMeetingPdf(orgId, plain)
      if (reportPdfPath) plain.reportPdfPath = reportPdfPath
    }
  }
  await setDoc(consultationRef(orgId, id), await sealDoc(orgId, SEALED, plain), { merge: true })
}

export async function deleteConsultation(orgId, id) {
  try {
    const snap = await getDoc(consultationRef(orgId, id))
    discardMailedReport(orgId, snap.data()?.reportPdfPath)
  } catch (e) {
    reportError(e, { source: 'committee.deleteConsultation.pdf', orgId })
  }
  await deleteDoc(consultationRef(orgId, id))
}
