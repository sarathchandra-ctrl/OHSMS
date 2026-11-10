// ─────────────────────────────────────────────────────────────────────────────
// All Firestore access for Permit to Work: org-scoped paths, the multi-org
// onboarding helpers, and the permit lifecycle (create → dual-team approval →
// closure / extension). Status is re-derived on read everywhere; we persist a
// `storedStatus` snapshot for list display + sorting.
// ─────────────────────────────────────────────────────────────────────────────
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  limit,
  runTransaction,
  arrayUnion,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { onReadError } from '../../../shared/org/readError'
import { reserveDocId } from '../../../shared/docId/reserve'
import { putFile, removeFile, MAX_INLINE_BYTES, tooLargeForInline } from '../../../shared/storage'
import { AUDIT } from './audit'
import { ANSWERABLE_STAGES, answerBlock, stageBlock } from './rejection'
import { computeWindow, derivePermitStatus } from './permitStatus'
import { mirrorDisplayFields } from './publicPermit'
import { generateQrToken } from './qr'
import { logAudit as logOrgAudit } from '../../../shared/org/orgData'
import { discardMailedReport } from '../../../shared/print/mailedReport'

// ── Path helpers ─────────────────────────────────────────────────────────────
const orgRef = () => doc(db, 'organization', 'profile')
const permitCol = () => collection(db, 'permits')
const permitRef = (id) => doc(db, 'permits', id)
const docCol = (permitId) => collection(db, 'permits', permitId, 'documents')
const docRef = (permitId, docId) => doc(db, 'permits', permitId, 'documents', docId)
const obsCol = () => collection(db, 'observations')
const qrRef = (token) => doc(db, 'permitQr', token)
const countersRef = () => doc(db, 'meta', 'counters')

// ── Audit log ─────────────────────────────────────────────────────────────────
// One implementation, in shared/org/orgData; this wrapper adds only the module
// key and the default target. The private copy it replaces omitted BOTH
// `module` and `source`, so permit entries read as "Core" in Admin → Audit Log
// and carried no origin at all.
const logAudit = (actor, action, details = {}) =>
  logOrgAudit(actor, action, { module: 'ptw', target: 'permit', ...details })

// ── Organizations & users ──────────────────────────────────────────────────────


// Delegated to the shared ref-counted users listener (one app-wide).
export { subscribeOrgUsers } from '../../../shared/org/orgData'

export function subscribeOrg(cb) {
  return onSnapshot(
    orgRef(),
    (snap) => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onReadError('the organization', cb, null),
  )
}

// ── Permits ─────────────────────────────────────────────────────────────────

const emptyDecision = () => ({ status: 'pending', by: null, byName: '', at: null, note: '' })

async function storedPermitDocuments(permitId) {
  try {
    const snap = await getDocs(docCol(permitId))
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  } catch {
    return []
  }
}

// The lifecycle mail reads reportPdfPath off the document this write stores.
// The print has to be in Storage first, or the function attaches nothing and
// sends the body alone. A failed capture must not fail the permit write.
async function mailedPermitPdf(permit, documents) {
  if (typeof document === 'undefined' || !permit) return ''
  try {
    const { capturePermitReport } = await import('./permitReportPdf.js')
    return await capturePermitReport(permit, documents || [])
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[Permit to Work] report PDF skipped:', e?.message || e)
    return ''
  }
}

/** Allocate the next sequential permit number for the org (PTW-YYYY-####). */
async function nextPermitNo(year) {
  const seq = await runTransaction(db, async (tx) => {
    const snap = await tx.get(countersRef())
    const cur = snap.exists() ? snap.data().permitSeq || 0 : 0
    const next = cur + 1
    tx.set(countersRef(), { permitSeq: next }, { merge: true })
    return next
  })
  return `PTW-${year}-${String(seq).padStart(4, '0')}`
}

// ── Public QR mirror (permitQr/{token}) ──────────────────────────────────────
// World-readable copy of the status-relevant + display fields, so the public
// /permit/:token scan page can render live details + a countdown without auth.

// Status fields the public page feeds into derivePermitStatus, kept in sync.
function mirrorStatusFields(p) {
  return {
    storedStatus: derivePermitStatus(p, Date.now()),
    engineering: { status: p.engineering?.status || 'pending' },
    operations: { status: p.operations?.status || 'pending' },
    closure: p.closure
      ? { engineering: { status: p.closure.engineering?.status || 'pending' }, operations: { status: p.closure.operations?.status || 'pending' } }
      : null,
    extension: p.extension
      ? { engineering: { status: p.extension.engineering?.status || 'pending' }, operations: { status: p.extension.operations?.status || 'pending' }, newValidTo: p.extension.newValidTo || null }
      : null,
    closedDueToObservation: p.closedDueToObservation || null,
    validFrom: p.validFrom || null,
    validTo: p.validTo || null,
    updatedAt: serverTimestamp(),
  }
}

// Full mirror written at create / backfill (display + status fields).
function fullMirror(orgName, permitId, p) {
  return {
    orgName: orgName || '',
    permitId,
    // Every field is defaulted: Firestore rejects `undefined`, and permits that
    // predate a column — or arrived by import or seed — legitimately lack one.
    // permitNo was the exception, so publishing the mirror threw for exactly the
    // legacy permits this function exists to heal, and the QR stayed dead.
    token: p.qrToken || '',
    permitNo: p.permitNo || '',
    docId: p.docId || '',
    site: p.site || '',
    // Crew as COUNTS, and the display half withdrawn once the job is over —
    // see publicPermit.js. This published every participant's name and employer
    // to an unauthenticated URL for the life of the permit and then forever.
    ...mirrorDisplayFields(p),
    ...mirrorStatusFields(p),
  }
}

/** Keep the public mirror's status fields current (fire-and-forget). */
export async function updatePermitMirror(token, mergedPermit) {
  if (!token) return
  try {
    // The display half rides along, so a permit that closes has its detail
    // actively blanked rather than left behind by a merge that only ever
    // touched the status fields — which was the 'never withdrawn' half of it.
    await setDoc(
      qrRef(token),
      { ...mirrorDisplayFields(mergedPermit), ...mirrorStatusFields(mergedPermit) },
      { merge: true },
    )
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[Permit to Work] permit mirror sync skipped:', e?.message || e)
  }
}

export function subscribePermitByToken(token, cb, onError) {
  return onSnapshot(
    qrRef(token),
    (snap) => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    (err) => { if (onError) onError(err); else cb(null) }
  )
}

/**
 * Ensure a permit has a QR token AND a current public mirror. Generates the
 * token if missing, then UPSERTS the full mirror — so it self-heals permits
 * whose mirror write was previously blocked (e.g. before the permitQr rule was
 * deployed) even though the token already exists on the permit. Non-fatal.
 */
export async function ensurePermitQr(orgName, permit) {
  if (!permit?.id) return null
  let token = permit.qrToken
  try {
    if (!token) {
      token = generateQrToken()
      await updateDoc(permitRef(permit.id), { qrToken: token, updatedAt: serverTimestamp() })
    }
    await setDoc(qrRef(token), fullMirror(orgName, permit.id, { ...permit, qrToken: token }))
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[Permit to Work] permit QR mirror ensure skipped:', e?.message || e)
  }
  return token
}

/** Create a new permit (status Draft, both team approvals pending). */
export async function createPermit(data, actor) {
  const year = (data.date || new Date().toISOString().slice(0, 10)).slice(0, 4)
  const permitNo = await nextPermitNo(year)
  const { validFrom, validTo } = computeWindow(data.date, data.time)
  const qrToken = generateQrToken()
  const ref = doc(permitCol())
  const permit = {
    permitNo,
    docId: await reserveDocId('ptw'),
    qrToken,
    date: data.date || '',
    time: data.time || '',
    typeOfWork: data.typeOfWork || '',
    site: data.site || '',
    // The weather digest matches a permit to a site on this id. The name alone
    // collides: two "Depot" sites would share each other's work types. The
    // form already collected it; older permits simply do not have it, and the
    // digest falls back to the name for those.
    siteId: typeof data.siteId === 'string' ? data.siteId.trim().slice(0, 128) : '',
    jobLocation: data.jobLocation || '',
    jobDescription: data.jobDescription || '',
    issuingDepartment: data.issuingDepartment || '',
    issuedToName: data.issuedToName || '',
    issuedToPhone: data.issuedToPhone || '',
    hazards: data.hazards || [],
    ppe: data.ppe || [],
    precautions: data.precautions || [],
    participants: data.participants || [],
    jsa: (data.jsa || []).filter((r) => r.step || r.hazard || r.precaution),
    fireWatchers: (data.fireWatchers || []).filter((w) => w.name),
    confinedWatcher: data.confinedWatcher?.name ? data.confinedWatcher : null,
    requiredDocs: data.requiredDocs || [],
    attachedDocKeys: (data.documents || []).map((d) => d.key),
    assignedEngineer: data.assignedEngineer || null,
    assignedOperator: data.assignedOperator || null,
    engineering: emptyDecision(),
    operations: emptyDecision(),
    closure: null,
    extension: null,
    validFrom,
    validTo,
    storedStatus: 'draft',
    createdBy: actor?.uid || null,
    createdByName: actor?.name || '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  // ── The attachments are PREPARED before the permit is written ──────────────
  //
  // This used to write the permit and then loop the documents, uploading each
  // one inside the loop. permitDocPayload is where the failures live — an
  // upload that cannot reach the bucket, an inline fallback over the size
  // limit — so a throw part-way left a permit that existed, had consumed its
  // number, and carried some of its MANDATORY documents, while the person who
  // raised it was told the whole thing had failed. On a hot-work permit the
  // missing document is the reason the permit is refusable.
  //
  // Preparing first means a failure happens while nothing has been written.
  // The permit number is still consumed, which reserve.js already treats as the
  // right trade: a gap in the sequence is harmless, a half-permit is not.
  const docPayloads = await Promise.all(
    (data.documents || []).map((d) => permitDocPayload(d, actor)),
  )
  // Before the create that sends the raised mail. The documents are not in
  // the subcollection yet; the print only needs their names and keys.
  const reportPdfPath = await mailedPermitPdf(
    permit,
    docPayloads.map((d, i) => ({ ...d, id: `new-${i}` })),
  )
  if (reportPdfPath) permit.reportPdfPath = reportPdfPath

  await setDoc(ref, permit)
  // Attached files live in a subcollection (each ≤ ~750 KB base64) so the parent
  // permit doc stays well under Firestore's 1 MB limit — which is also why they
  // are not batched with the permit: several inline documents would exceed the
  // batch's own ceiling.
  for (const payload of docPayloads) {
    await addDoc(docCol(ref.id), payload)
  }
  // Public QR mirror so the permit is scannable immediately.
  await setDoc(qrRef(qrToken), fullMirror(actor?.orgName, ref.id, permit)).catch((e) =>
    console.warn('[Permit to Work] mirror create skipped:', e?.message || e))
  await logAudit(actor, AUDIT.PERMIT_CREATE, {
    targetId: ref.id, targetLabel: permitNo, summary: `${permit.typeOfWork} @ ${permit.jobLocation}`,
  })
  return { id: ref.id, permitNo, qrToken }
}

// ── Observations (safety observations logged via QR scan or in-app) ──────────
export function subscribeObservations(cb) {
  const q = query(obsCol(), orderBy('at', 'desc'), limit(500))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('observations', cb),
  )
}

export function subscribePermitObservations(permitId, cb) {
  const q = query(obsCol(), where('permitId', '==', permitId))
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      list.sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0))
      cb(list)
    },
    onReadError('observations on this permit', cb),
  )
}

/**
 * Log a safety observation against a permit. A SAFE observation leaves the
 * permit open; an UNSAFE observation closes it for non-compliance (terminal).
 */
export async function createObservation(data, actor) {
  const ref = await addDoc(obsCol(), {
    permitId: data.permitId,
    docId: await reserveDocId('observations'),
    permitNo: data.permitNo || '',
    token: data.token || '',
    type: data.type, // 'safe' | 'unsafe'
    note: data.note || '',
    observedBy: actor?.uid || null,
    observedByName: actor?.name || '',
    observedByRole: actor?.role || '',
    source: data.source || 'portal',
    at: serverTimestamp(),
  })

  if (data.type === 'unsafe') {
    const closure = {
      observationId: ref.id,
      by: actor?.uid || null,
      byName: actor?.name || '',
      at: new Date().toISOString(),
      note: data.note || '',
    }
    const current = await getPermit(data.permitId)
    const merged = { ...(current || {}), closedDueToObservation: closure }
    const reportPdfPath = await mailedPermitPdf(
      merged,
      await storedPermitDocuments(data.permitId),
    )
    await updateDoc(permitRef(data.permitId), {
      closedDueToObservation: closure,
      storedStatus: 'closed_noncompliance',
      updatedAt: serverTimestamp(),
      ...(reportPdfPath ? { reportPdfPath } : {}),
    })
    await updatePermitMirror(data.token || current?.qrToken, merged)
  }

  await logAudit(actor, data.type === 'unsafe' ? AUDIT.OBSERVATION_UNSAFE : AUDIT.OBSERVATION_SAFE, {
    targetId: data.permitId, targetLabel: data.permitNo || data.permitId,
    summary: `${data.type === 'unsafe' ? 'Unsafe — permit closed for non-compliance' : 'Safe observation'}${data.note ? ` — ${data.note}` : ''}`,
  })
  return ref.id
}

/** Who a QR observation can say they are. Free text would be worthless here. */
export const OBSERVER_ROLES = [
  'Worker on this permit',
  'Supervisor',
  'Safety officer',
  'Contractor',
  'Visitor',
  'Other',
]

/**
 * An observation logged by scanning the permit's QR code, by someone with no
 * account.
 *
 * Deliberately NOT the same as the signed-in path. A portal observation of
 * "unsafe" closes the permit for non-compliance on the spot; doing that from an
 * unauthenticated write would put a stop-work button on a token printed on a
 * sheet of paper that anyone can photograph. So a scanned observation is
 * recorded and left pending for an approver, exactly as a scanned equipment
 * defect is — the report is immediate, the consequence is a decision.
 *
 * It also cannot reserve a document id or write an audit entry, both of which
 * require membership. The observation is its own record.
 */
export async function createPublicObservation(data) {
  const ref = await addDoc(obsCol(), {
    permitId: data.permitId,
    permitNo: data.permitNo || '',
    token: data.token || '',
    type: data.type === 'unsafe' ? 'unsafe' : 'safe',
    note: (data.note || '').slice(0, 500),
    observedBy: 'public',
    observedByName: data.reporterRole || 'QR Scan (Public)',
    observedByRole: data.reporterRole || '',
    source: 'qr',
    approvalStatus: 'pending',
    at: serverTimestamp(),
  })
  return ref.id
}

// ── Permit documents (base64 files in a subcollection) ───────────────────────
export function subscribePermitDocuments(permitId, cb) {
  const q = query(docCol(permitId), orderBy('uploadedAt', 'asc'))
  // fileData is normalised at the seam so the download links keep working for
  // both eras: inline base64 (legacy) and cloud URL (new).
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => {
      const data = d.data()
      return { id: d.id, ...data, fileData: data.fileData || data.fileUrl || '' }
    })),
    onReadError('permit documents', cb),
  )
}

/**
 * The stored shape of one attached document. Cloud storage first — the permit
 * subcollection doc then carries a URL instead of up to ~750KB of base64 —
 * falling back to inline when the bucket is unavailable, so attaching a
 * document never fails harder than it did before storage existed.
 */
async function permitDocPayload(meta, actor) {
  const up = meta.fileData ? await putFile('permit-documents', meta.fileData, meta.fileName) : null
  if (!up && meta.fileData && (meta.size || 0) > MAX_INLINE_BYTES) {
    throw new Error(tooLargeForInline(meta.fileName))
  }
  return {
    key: meta.key || 'extra',
    label: meta.label || '',
    mandatory: Boolean(meta.mandatory),
    fileName: meta.fileName || '',
    fileType: meta.fileType || '',
    fileData: up ? '' : meta.fileData || '',
    fileUrl: up?.url || '',
    filePath: up?.path || '',
    size: meta.size || 0,
    uploadedByName: actor?.name || '',
    uploadedAt: serverTimestamp(),
  }
}

/** Attach a document to an existing permit; updates attachedDocKeys. */
export async function addPermitDocument(permitId, meta, actor) {
  await addDoc(docCol(permitId), await permitDocPayload(meta, actor))
  if (meta.key) {
    await updateDoc(permitRef(permitId), {
      attachedDocKeys: arrayUnion(meta.key), updatedAt: serverTimestamp(),
    })
  }
  await logAudit(actor, AUDIT.PERMIT_EDIT, {
    targetId: permitId, summary: `Attached document: ${meta.label || meta.fileName || meta.key}`,
  })
}

export async function deletePermitDocument(permitId, docId, actor, label) {
  // The doc is the only record of its cloud path.
  try {
    const snap = await getDoc(docRef(permitId, docId))
    if (snap.data()?.filePath) removeFile(snap.data().filePath)
  } catch { /* orphan tolerated */ }
  await deleteDoc(docRef(permitId, docId))
  await logAudit(actor, AUDIT.PERMIT_EDIT, {
    targetId: permitId, summary: `Removed document: ${label || docId}`,
  })
}

export function subscribePermits(cb) {
  const q = query(permitCol(), orderBy('createdAt', 'desc'), limit(1000))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('permits', cb),
  )
}

export async function getPermit(id) {
  const snap = await getDoc(permitRef(id))
  return snap.exists() ? { id, ...snap.data() } : null
}

/** Recompute + persist storedStatus when it drifts; keep the public mirror in sync. */
async function syncStoredStatus(id, merged) {
  const live = derivePermitStatus(merged, Date.now())
  if (merged.storedStatus !== live) {
    await updateDoc(permitRef(id), { storedStatus: live, updatedAt: serverTimestamp() })
  }
  await updatePermitMirror(merged.qrToken, merged)
}

/**
 * Opportunistically persist an expired permit's status (Not Closed) so the
 * repository/dashboard reflect it without a backend cron. Fire-and-forget.
 */
export async function reconcilePermitStatus(permit) {
  try {
    const live = derivePermitStatus(permit, Date.now())
    if (permit?.id && permit.storedStatus !== live) {
      await updateDoc(permitRef(permit.id), { storedStatus: live })
      await updatePermitMirror(permit.qrToken, permit)
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[Permit to Work] status reconcile skipped:', e?.message || e)
  }
}

/**
 * Delete a permit, its attached documents and its public QR mirror.
 *
 * The mirror goes first and on its own: leaving it behind would keep a scanned
 * QR answering for a permit that no longer exists, which is worse than the code
 * simply not resolving. The audit entry is written before the document is
 * removed, because afterwards there is nothing left to describe.
 */
export async function deletePermit(permit, actor) {
  const id = permit?.id
  if (!id) throw new Error('No permit to delete')

  await logAudit(actor, AUDIT.PERMIT_DELETE, {
    targetId: id,
    targetLabel: permit.permitNo || id,
    summary: `Deleted permit ${permit.permitNo || id}${permit.typeOfWork ? ` (${permit.typeOfWork})` : ''}`,
  })

  discardMailedReport(permit.reportPdfPath)

  if (permit.qrToken) {
    try {
      await deleteDoc(qrRef(permit.qrToken))
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Permit to Work] QR mirror delete skipped:', e?.message || e)
    }
  }

  // Attachments live in a subcollection, which deleting the parent leaves
  // orphaned and unreachable.
  const docs = await getDocs(docCol(id))
  for (const d of docs.docs) {
    if (d.data().filePath) removeFile(d.data().filePath)
    await deleteDoc(d.ref)
  }

  await deleteDoc(permitRef(id))
}

function decisionBlock(decision, actor, note) {
  return {
    status: decision, // 'approved' | 'rejected'
    by: actor?.uid || null,
    byName: actor?.name || '',
    at: new Date().toISOString(),
    note: note || '',
  }
}

/** Record a team's approve/reject decision on the permit itself. */
export async function decideApproval(permitId, team, decision, note, actor) {
  const current = await getPermit(permitId)
  if (!current) throw new Error('Permit no longer exists')
  const block = decisionBlock(decision, actor, note)
  const merged = { ...current, [team]: block }
  const reportPdfPath = await mailedPermitPdf(
    merged,
    await storedPermitDocuments(permitId),
  )
  await updateDoc(permitRef(permitId), {
    [team]: block,
    updatedAt: serverTimestamp(),
    ...(reportPdfPath ? { reportPdfPath } : {}),
  })
  await syncStoredStatus(permitId, merged)
  await logAudit(actor, decision === 'approved' ? AUDIT.APPROVE : AUDIT.REJECT, {
    targetId: permitId, targetLabel: current.permitNo,
    summary: `${team} ${decision}${note ? ` — ${note}` : ''}`,
  })
}

/**
 * The raiser answers a team's rejection of the opening ('permit') or the
 * closure, and sends it back to the person who rejected it (lib/rejection.js).
 */
export async function answerRejection(permitId, stage, team, text, actor) {
  if (!ANSWERABLE_STAGES.includes(stage)) throw new Error('Only an opening or a closure can be answered')
  const current = await getPermit(permitId)
  if (!current) throw new Error('Permit no longer exists')
  const block = answerBlock(stageBlock(current, stage, team), text, actor)
  const merged =
    stage === 'permit'
      ? { ...current, [team]: block }
      : { ...current, closure: { ...current.closure, [team]: block } }
  await updateDoc(permitRef(permitId), {
    [stage === 'permit' ? team : `closure.${team}`]: block,
    updatedAt: serverTimestamp(),
  })
  await syncStoredStatus(permitId, merged)
  await logAudit(actor, AUDIT.REJECTION_ANSWER, {
    targetId: permitId,
    targetLabel: current.permitNo,
    summary: `${stage === 'closure' ? 'Closure ' : ''}${team} rejection answered, sent back to ${block.reapproverName || 'the approver'}`,
  })
}

/** The raiser submits the completed work for closure (both teams must approve). */
export async function requestClosure(permitId, actor) {
  const closure = {
    requestedBy: actor?.uid || null,
    requestedByName: actor?.name || '',
    requestedAt: new Date().toISOString(),
    engineering: emptyDecision(),
    operations: emptyDecision(),
  }
  const current = await getPermit(permitId)
  const merged = { ...(current || {}), closure }
  const reportPdfPath = await mailedPermitPdf(
    merged,
    await storedPermitDocuments(permitId),
  )
  await updateDoc(permitRef(permitId), {
    closure,
    updatedAt: serverTimestamp(),
    ...(reportPdfPath ? { reportPdfPath } : {}),
  })
  await logAudit(actor, AUDIT.CLOSURE_REQUEST, { targetId: permitId, summary: 'Submitted for closure' })
}

export async function decideClosure(permitId, team, decision, note, actor) {
  const current = await getPermit(permitId)
  if (!current?.closure) throw new Error('No closure request is pending')
  const block = decisionBlock(decision, actor, note)
  const closure = { ...current.closure, [team]: block }
  const merged = { ...current, closure }
  const reportPdfPath = await mailedPermitPdf(
    merged,
    await storedPermitDocuments(permitId),
  )
  await updateDoc(permitRef(permitId), {
    closure,
    updatedAt: serverTimestamp(),
    ...(reportPdfPath ? { reportPdfPath } : {}),
  })
  await syncStoredStatus(permitId, merged)
  await logAudit(actor, AUDIT.CLOSURE_DECISION, {
    targetId: permitId, targetLabel: current.permitNo, summary: `Closure ${team} ${decision}`,
  })
}

/** Request a time extension (reason + new end + participant/risk changes). */
export async function requestExtension(permitId, { reason, newValidTo, participantChanges, riskChanges }, actor) {
  const extension = {
    requestedBy: actor?.uid || null,
    requestedByName: actor?.name || '',
    requestedAt: new Date().toISOString(),
    reason: reason || '',
    newValidTo: newValidTo || null,
    participantChanges: participantChanges || '',
    riskChanges: riskChanges || '',
    suggestions: [],
    engineering: emptyDecision(),
    operations: emptyDecision(),
  }
  const current = await getPermit(permitId)
  const merged = { ...(current || {}), extension }
  const reportPdfPath = await mailedPermitPdf(
    merged,
    await storedPermitDocuments(permitId),
  )
  await updateDoc(permitRef(permitId), {
    extension,
    updatedAt: serverTimestamp(),
    ...(reportPdfPath ? { reportPdfPath } : {}),
  })
  await logAudit(actor, AUDIT.EXTENSION_REQUEST, {
    targetId: permitId, summary: `Extension requested${reason ? ` — ${reason}` : ''}`,
  })
}

/** An approver adds a suggestion and may revise the proposed new end time. */
export async function addExtensionSuggestion(permitId, { text, newValidTo }, actor) {
  const updates = {
    'extension.suggestions': arrayUnion({
      by: actor?.uid || null,
      byName: actor?.name || '',
      text: text || '',
      at: new Date().toISOString(),
    }),
    updatedAt: serverTimestamp(),
  }
  if (newValidTo) updates['extension.newValidTo'] = newValidTo
  await updateDoc(permitRef(permitId), updates)
  await logAudit(actor, AUDIT.EXTENSION_SUGGESTION, {
    targetId: permitId, summary: `Suggestion: ${text || ''}${newValidTo ? ` (new end ${newValidTo})` : ''}`,
  })
}

export async function decideExtension(permitId, team, decision, note, actor) {
  const current = await getPermit(permitId)
  if (!current?.extension) throw new Error('No extension request is pending')
  const block = decisionBlock(decision, actor, note)
  const extension = { ...current.extension, [team]: block }
  const merged = { ...current, extension }
  // When both teams approve, the extended end becomes the permit's validTo.
  const bothApproved = extension.engineering?.status === 'approved' && extension.operations?.status === 'approved'
  const patch = { extension, updatedAt: serverTimestamp() }
  if (bothApproved && extension.newValidTo) {
    patch.validTo = extension.newValidTo
    merged.validTo = extension.newValidTo
  }
  const reportPdfPath = await mailedPermitPdf(
    merged,
    await storedPermitDocuments(permitId),
  )
  if (reportPdfPath) patch.reportPdfPath = reportPdfPath
  await updateDoc(permitRef(permitId), patch)
  await syncStoredStatus(permitId, merged)
  await logAudit(actor, AUDIT.EXTENSION_DECISION, {
    targetId: permitId, targetLabel: current.permitNo, summary: `Extension ${team} ${decision}`,
  })
}
