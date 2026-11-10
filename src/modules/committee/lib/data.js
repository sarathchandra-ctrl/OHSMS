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
import { COLLECTION_READ_CAP } from '../../../shared/org/orgData'
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
const consultationCol = () => collection(db, 'consultations')
const consultationRef = (id) => doc(db, 'consultations', id)

// ── Organizations & users ─────────────────────────────────────────────────────


// Delegated to the shared ref-counted users listener (one app-wide).
export { subscribeOrgUsers } from '../../../shared/org/orgData'

// ── Sites (organizations/{orgId}/sites) ────────────────────────────────────────
// Facility sites the committee meetings are scoped/filtered by. { code, name }.

// Delegated to the shared ref-counted org-sites listener (one per org app-wide).
export { subscribeSites } from '../../../shared/org/orgData'

// ── Consultations / meetings (organizations/{orgId}/consultations) ──────────────

export function subscribeConsultations(cb, onError) {
  // openSnapshots drops any batch that is no longer the latest — decryption is
  // async and this listener has no orderBy, so a re-emission can overtake the
  // batch before it and put an older list on screen.
  const opened = openSnapshots(SEALED, cb)
  // Capped: minutes accumulate for the life of the organization and nothing
  // ever removes them, so this is the collection most certain to grow without
  // bound. No orderBy, deliberately — see subscribeCollections in orgData.
  return onSnapshot(
    query(consultationCol(), limit(COLLECTION_READ_CAP)),
    (snap) => opened(snap.docs.map((d) => ({ docKey: d.id, ...d.data() }))),
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

async function meetingSiteLabel(siteId) {
  if (!siteId) return '—'
  try {
    const snap = await getDoc(doc(db, 'sites', siteId))
    return snap.exists() ? snap.data()?.name || siteId : siteId
  } catch {
    return siteId
  }
}

// The mail fires on the write that first stores minutes. The PDF has to be in
// Storage before that write, named on the document, or the function attaches
// nothing. A later edit of minutes that are already there is not a second mail,
// so it does not upload another copy.
async function mailedMeetingPdf(meeting) {
  if (typeof document === 'undefined' || !hasMinutes(meeting)) return ''
  try {
    const { captureMeetingReport } = await import('./meetingReportPdf.js')
    const siteLabel = await meetingSiteLabel(meeting.siteId)
    return await captureMeetingReport(meeting, siteLabel)
  } catch (e) {
    reportError(e, { source: 'committee.mailedMeetingPdf' })
    return ''
  }
}

export async function addConsultation(data) {
  const docId = data.docId || (await reserveDocId('committee'))
  const plain = { ...data, docId }
  const reportPdfPath = await mailedMeetingPdf(plain)
  if (reportPdfPath) plain.reportPdfPath = reportPdfPath
  const ref = await addDoc(consultationCol(), {
    ...(await sealDoc(SEALED, plain)),
    // Sealed AFTER the spread so these two cannot be overwritten by a caller's
    // payload, and outside it because neither is in the policy: docId is the
    // org-wide reference the calendar and the printed minutes quote, and
    // createdAt is a write sentinel with no plaintext to seal.
    docId,
    createdAt: serverTimestamp(),
  })
  return ref.id
}

export async function updateConsultation(id, data) {
  const plain = { ...data }
  if (hasMinutes(plain)) {
    let prior = false
    try {
      const prev = await getDoc(consultationRef(id))
      prior = hasMinutes(prev.data())
    } catch (e) {
      reportError(e, { source: 'committee.updateConsultation.prior' })
    }
    if (!prior) {
      const reportPdfPath = await mailedMeetingPdf(plain)
      if (reportPdfPath) plain.reportPdfPath = reportPdfPath
    }
  }
  await setDoc(consultationRef(id), await sealDoc(SEALED, plain), { merge: true })
}

export async function deleteConsultation(id) {
  try {
    const snap = await getDoc(consultationRef(id))
    discardMailedReport(snap.data()?.reportPdfPath)
  } catch (e) {
    reportError(e, { source: 'committee.deleteConsultation.pdf' })
  }
  await deleteDoc(consultationRef(id))
}
