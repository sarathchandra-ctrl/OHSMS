// ─────────────────────────────────────────────────────────────────────────────
// All incident data access: org-scoped paths, the resumable 5-step document,
// scene photos, soft-delete, and the dashboard stats counter (maintained with
// increment() deltas, fire-and-forget). Medical files are not in this module.
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
  orderBy,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  limit,
  increment,
  runTransaction,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { onReadError } from '../../../shared/org/readError'
import { logAudit } from './firestore'
import { AUDIT, diffSummary } from './audit'
import { statsDeltaFor, emptyStats, BUCKETS } from './stats'
import { incidentInjuryStubs } from './injuries'
import { stampNewAssignees } from '../../../shared/org/stampAssignee'
import { reserveDocId } from '../../../shared/docId/reserve'
import { putFile, removeFile, MAX_INLINE_BYTES, tooLargeForInline } from '../../../shared/storage'
// Sealed under the GENERAL class — a symmetric org key held by everyone who can
// read an incident anyway, auditor included. It buys nothing against a member,
// and is not meant to: what it stands between is this data and everything that
// reaches the STORE rather than the app. The clinical detail that used to ride
// on this document is in /injuries under the medical keypair instead.
import { sealDoc, openDoc, openSnapshots } from '../../../shared/crypto'
import { discardMailedReport } from '../../../shared/print/mailedReport'
import { resolveSubscription } from '../../../shared/storage/resolveFiles'

/** The policy key for this collection. See src/shared/crypto/policy.js. */
const SEALED = 'incidents'
const SEALED_PHOTOS = 'incidents/photos'

const BUCKET_NAMES = Object.keys(BUCKETS)

// ── Path helpers ─────────────────────────────────────────────────────────────
const incidentCol = () => collection(db, 'incidents')
const incidentRef = (id) => doc(db, 'incidents', id)
const photoCol = (id) => collection(db, 'incidents', id, 'photos')
const photoRef = (id, pid) => doc(db, 'incidents', id, 'photos', pid)
const statsRef = () => doc(db, 'meta', 'stats')

export const INCIDENT_LOAD_CAP = 2000

// ── Stats counter ─────────────────────────────────────────────────────────────
// Apply a sparse delta as increment() field updates. NON-BLOCKING — never throws
// out; a stats failure must not roll back the real write. Uses updateDoc (which
// interprets dotted field paths e.g. "bySeverity.high"), self-healing the doc if
// it doesn't exist yet.
async function bumpStats(delta) {
  if (!delta) return
  const fields = {}
  if (delta.total) fields.total = increment(delta.total)
  for (const bucket of BUCKET_NAMES) {
    const m = delta[bucket]
    if (!m) continue
    for (const k of Object.keys(m)) if (m[k]) fields[`${bucket}.${k}`] = increment(m[k])
  }
  if (Object.keys(fields).length === 0) return
  fields.updatedAt = serverTimestamp()
  try {
    await updateDoc(statsRef(), fields)
  } catch (e) {
    try {
      // Seed WITHOUT nextSeq. emptyStats() carries nextSeq: 0, and a merge
      // writes every field it names — seeding with it intact would rewind the
      // reference-number counter and hand the next incident a number that is
      // already printed on one.
      const seed = emptyStats()
      delete seed.nextSeq
      await setDoc(statsRef(), seed, { merge: true })
      await updateDoc(statsRef(), fields)
    } catch (e2) {
      // eslint-disable-next-line no-console
      console.warn('[Incident IRA] stats update skipped:', e2?.message || e2)
    }
  }
}

export function subscribeStats(cb) {
  return onSnapshot(
    statsRef(),
    (snap) => cb(snap.exists() ? snap.data() : null),
    onReadError('the incident counters', cb, null),
  )
}

// ── Incident document ─────────────────────────────────────────────────────────

/**
 * Normalize an incident's investigations to an array. New incidents store
 * `investigations: [{ id, method, diagram, summary, pngPhotoId }]`; older docs
 * stored a single `investigation` object — wrap it for backward compatibility.
 */
export function incidentInvestigations(incident) {
  if (Array.isArray(incident?.investigations)) return incident.investigations
  const legacy = incident?.investigation
  if (legacy && legacy.method) {
    return [{ id: 'legacy', method: legacy.method, diagram: legacy.diagram, summary: legacy.summary || '', pngPhotoId: legacy.pngPhotoId || null }]
  }
  return []
}

// ── Reference numbers ─────────────────────────────────────────────────────────

/**
 * The reference-number format. Fixed: records already carry these numbers into
 * closed investigations, emails and regulator correspondence, so a number
 * issued today has to come out looking exactly like one issued last year.
 */
export const formatRefNo = (prefix, year, seq) => `${prefix}-${year}-${String(seq).padStart(4, '0')}`

/**
 * The number to issue, given a counter document's contents (or null when the
 * counter does not exist yet). Defensive about what it finds because `nextSeq`
 * is an ordinary Firestore field: a string "7" read straight would produce
 * IRA-2026-0071 via "7" + 1, and a missing or corrupt one IRA-2026-0NaN —
 * neither of which anything downstream would notice.
 */
export function nextRefSeq(data) {
  const n = Math.floor(Number(data?.nextSeq))
  return (Number.isFinite(n) && n > 0 ? n : 0) + 1
}

/**
 * Reserve the next reference number, reading and advancing the counter in a
 * single transaction — the pattern in shared/docId/reserve.js.
 *
 * A read-then-write hands two people filing at the same moment the SAME
 * number, and these are the records that get quoted to a regulator. The
 * transaction also carries reserve.js's bargain: the number is consumed the
 * moment it is reserved, so a create that fails afterwards leaves a gap in the
 * sequence. A gap is harmless. Two records sharing a number is not.
 *
 * Exported because illnesses.js numbers its records from its own counter with
 * the same format and the same guarantee.
 */
export async function reserveRefNo(counterDoc, prefix) {
  const seq = await runTransaction(db, async (tx) => {
    const snap = await tx.get(counterDoc)
    const next = nextRefSeq(snap.exists() ? snap.data() : null)
    // merge: the incident counter shares meta/stats with the dashboard totals,
    // which this must not touch.
    tx.set(counterDoc, { nextSeq: next, updatedAt: serverTimestamp() }, { merge: true })
    return next
  })
  return formatRefNo(prefix, new Date().getFullYear(), seq)
}

/** Create a new incident (optionally pre-filled with Step-1 data). Returns id. */
export async function createIncident(actor, initial = {}) {
  // Both identifiers are reserved before anything is written, so a failure to
  // issue one leaves no half-created incident behind — only an unused number.
  const refNo = await reserveRefNo(statsRef(), 'IRA')
  const docId = await reserveDocId('incidents')
  const ref = doc(incidentCol())
  const incident = {
    // The org-wide document id. refNo is kept alongside it because incidents
    // raised before this scheme are quoted by that number in closed
    // investigations and emails, and dropping it would strand those references.
    docId,
    refNo,
    lifecycle: 'reporting',
    stagesDone: { initial: false, team: false, investigation: false, capa: false, horizontal: false },
    deletedAt: null,
    closedAt: null,
    closedBy: null,
    // Step 1
    incidentDate: initial.incidentDate || '',
    incidentTime: initial.incidentTime || '',
    type: initial.type || '',
    severity: initial.severity || '',
    category: initial.category || '',
    location: initial.location || '',
    region: initial.region || '',
    entity: initial.entity || '',
    siteId: initial.siteId || '',
    site: initial.site || '',
    narrative: initial.narrative || '',
    probableCause: initial.probableCause || '',
    affectedPersonnel: initial.affectedPersonnel || [],
    photoCount: 0,
    // Step 1a — the join key only. The clinical detail that used to sit here
    // goes to /injuries (see injuries.js): this document is readable by every
    // approved member and by the external auditor, so anything on it is
    // published to all of them.
    injuryReports: incidentInjuryStubs(initial.injuryReports),
    // Step 2
    team: initial.team || [],
    // Step 3 — the established sequence of events, and the analyses built on
    // it. Both live on the incident; see lib/chronology.js for why the timeline
    // belongs to the event rather than to any one investigation method.
    chronology: [],
    investigations: [],
    // Step 4
    capa: [],
    // Step 5
    horizontal: { required: null, locations: [], details: '', completedAt: null },
    createdBy: actor?.uid || null,
    createdByName: actor?.name || '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  await setDoc(ref, await sealDoc(SEALED, incident))
  // The delta is computed from the PLAINTEXT incident, not the sealed copy.
  // Every dimension it counts — type, severity, category, location, lifecycle —
  // is left readable by the policy, so the two agree today; passing the sealed
  // copy would still be wrong the first time a counted field is added to the
  // policy, and the counters would drift with nothing to show for it.
  await bumpStats(statsDeltaFor(null, incident))
  await logAudit(actor, AUDIT.INCIDENT_CREATE, {
    target: 'incident',
    targetId: ref.id,
    targetLabel: incident.docId,
    summary: `Incident ${incident.docId} created`,
  })
  return ref.id
}

/**
 * Update an incident; keeps the stats counter in sync. `opts` = { actor, action,
 * summary, silent } drives the audit entry. Supports dotted-path updates for
 * nested fields (e.g. 'investigation.method', 'stagesDone.team') — those are
 * passed straight through to updateDoc.
 *
 * `injuryReports` is narrowed to the join key on the way through. Doing it at
 * this seam rather than at each call site is the point: the medical detail
 * reached every member and the external auditor because ONE writer put it on
 * this document, and a rule that lives in the caller is a rule the next caller
 * will not know about.
 */
export async function updateIncident(id, updates, opts = {}) {
  // assignedByUid is what the assignment-mail trigger uses to skip a person
  // assigning the action to themselves, and to name the assigner. It is a
  // uid, so it stays unsealed — the same decision ownerUid already got.
  // Stamped only when the owner changed: a later edit of the due date must
  // not replace the person who actually assigned it.
  let safe = 'injuryReports' in updates
    ? { ...updates, injuryReports: incidentInjuryStubs(updates.injuryReports) }
    : { ...updates }
  if (Array.isArray(safe.capa) && opts.actor?.uid) {
    const prev = await getDoc(incidentRef(id))
    safe.capa = stampNewAssignees(prev.exists() ? prev.data()?.capa : [], safe.capa, opts.actor.uid)
  }
  // Sealed OUTSIDE the transaction. It depends only on `updates`, and a
  // transaction body can retry — running RSA/AES over the same fields on every
  // attempt would be work for nothing.
  const sealed = { ...await sealDoc(SEALED, safe), updatedAt: serverTimestamp() }

  // ── Read and write in one transaction ──────────────────────────────────────
  //
  // This was getDoc-then-updateDoc, and the stats delta was computed from the
  // `before` that first read returned. Two people editing the same incident —
  // one changing severity, one closing it — each emitted a delta from the same
  // baseline, so meta/stats drifted by exactly the change they disagreed about.
  // Permanently: nothing recomputes it, bumpStats swallows its own failures,
  // and the dashboard is where those totals are read from. The reference-number
  // counter in the very same document has been transactional for a while.
  let before = null
  let merged = null
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(incidentRef(id))
    if (!snap.exists()) throw new Error('Incident not found')
    before = snap.data()
    // Build a shallow "merged" view for the stats delta (only top-level dimension
    // fields matter: type/severity/category/location/lifecycle/deletedAt).
    merged = { ...before }
    for (const [k, v] of Object.entries(safe)) {
      if (!k.includes('.')) merged[k] = v
    }
    tx.update(incidentRef(id), sealed)
  })
  // `before` is as stored — sealed — and `merged` mixes it with plaintext
  // updates. Neither is opened, and neither needs to be: every dimension the
  // delta counts is left readable by the policy. diffSummary below handles the
  // mismatch itself, reporting a sealed field as changed without printing
  // either side into /auditLogs.
  await bumpStats(statsDeltaFor(before, merged))
  if (!opts.silent) {
    await logAudit(opts.actor, opts.action || AUDIT.INCIDENT_UPDATE, {
      target: 'incident',
      targetId: id,
      targetLabel: before.refNo || id,
      summary: opts.summary || diffSummary(before, merged),
    })
  }
}

export async function getIncident(id) {
  const snap = await getDoc(incidentRef(id))
  return snap.exists() ? openDoc(SEALED, { id, ...snap.data() }) : null
}

export function subscribeIncidents(cb, max = INCIDENT_LOAD_CAP) {
  const q = query(incidentCol(), orderBy('createdAt', 'desc'), limit(max))
  const opened = openSnapshots(SEALED, cb)
  // The fallback goes to `cb`, not to `opened`: there is nothing to unseal, and
  // routing an empty list through the decryption step would report a read
  // failure as a decryption failure.
  return onSnapshot(
    q,
    (snap) => opened(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('incidents', cb),
  )
}

/** Mark an incident closed (after horizontal-deployment step). */
export async function closeIncident(id, actor) {
  await updateIncident(id, {
    lifecycle: 'closed',
    'stagesDone.horizontal': true,
    closedAt: serverTimestamp(),
    closedBy: actor?.name || '',
  }, { actor, action: AUDIT.INCIDENT_CLOSE, summary: 'Incident closed' })
}

// ── Soft delete / restore / purge ─────────────────────────────────────────────
export async function deleteIncident(id, actor) {
  const snap = await getDoc(incidentRef(id))
  if (!snap.exists()) return
  const before = snap.data()
  await updateDoc(incidentRef(id), { deletedAt: serverTimestamp(), deletedBy: actor?.name || '' })
  await bumpStats(statsDeltaFor(before, { ...before, deletedAt: true }))
  await logAudit(actor, AUDIT.INCIDENT_DELETE, { target: 'incident', targetId: id, targetLabel: before.refNo || id })
}

export async function restoreIncident(id, actor) {
  const snap = await getDoc(incidentRef(id))
  if (!snap.exists()) return
  const data = snap.data()
  await updateDoc(incidentRef(id), { deletedAt: null, deletedBy: null, updatedAt: serverTimestamp() })
  await bumpStats(statsDeltaFor({ ...data, deletedAt: true }, { ...data, deletedAt: null }))
  await logAudit(actor, AUDIT.INCIDENT_RESTORE, { target: 'incident', targetId: id, targetLabel: data.refNo || id })
}

export async function purgeIncident(id, actor, label) {
  // The mailed PDF is a plaintext rendering of this report. It goes with the
  // record; a purge that left it would keep the narrative after the incident
  // itself was gone.
  try {
    const parent = await getDoc(incidentRef(id))
    discardMailedReport(parent.data()?.reportPdfPath)
  } catch { /* orphan tolerated */ }
  // Remove photos subcollection then the doc.
  const photos = await getDocs(photoCol(id))
  photos.docs.forEach((d) => { if (d.data().path) removeFile(d.data().path) })
  const batch = writeBatch(db)
  photos.docs.forEach((d) => batch.delete(d.ref))
  batch.delete(incidentRef(id))
  await batch.commit()
  await logAudit(actor, AUDIT.INCIDENT_PURGE, { target: 'incident', targetId: id, targetLabel: label || id })
}

// ── Scene photos and investigation diagrams ───────────────────────────────────
// Medical records do not belong here. This subcollection is readable by every
// approved member and by the auditor, and its bytes sit under `incident-photos`,
// which storage.rules hands to the same people. A GP letter filed beside a
// guard-rail photo is the letter. addMedicalRecord in injuries.js is the writer.
export async function addIncidentPhoto(id, photo) {
  if (photo?.kind === 'medical_record') {
    throw new Error('Medical records are filed on the injury report, not with the incident photos.')
  }
  // Cloud first; the photo document then holds a URL instead of the image.
  // putFile returning null (bucket not enabled, offline) keeps the legacy
  // inline path, so evidence upload never fails harder than it used to.
  const up = photo.dataUrl
    ? await putFile('incident-photos', photo.dataUrl, photo.name, { collection: SEALED_PHOTOS })
    : null
  // No bucket: the file would be written base64 INSIDE this document, and
  // Firestore rejects anything over 1MB with an error nobody can act on. Refuse
  // it here with a sentence that says what to do instead.
  if (!up && photo.dataUrl && (photo.size || 0) > MAX_INLINE_BYTES) {
    throw new Error(tooLargeForInline(photo.name))
  }
  const ref = await addDoc(photoCol(id), await sealDoc(SEALED_PHOTOS, {
    name: photo.name || '',
    type: photo.type || '',
    dataUrl: up ? '' : photo.dataUrl,
    url: up?.url || '',
    path: up?.path || '',
    size: photo.size || 0,
    caption: photo.caption || '',
    kind: photo.kind || 'photo', // 'photo' | 'medical_record' | 'diagram'
    uploadedBy: photo.uploadedBy || '',
    uploadedAt: serverTimestamp(),
    ...(up?.encIv ? { encScheme: up.encScheme, encKeyId: up.encKeyId, encIv: up.encIv, ...(up.encWrapped ? { encWrapped: up.encWrapped } : {}) } : {}),
  }))
  await updateDoc(incidentRef(id), { photoCount: increment(1), updatedAt: serverTimestamp() })
  return ref.id
}

export function subscribeIncidentPhotos(id, cb) {
  const q = query(photoCol(id), orderBy('uploadedAt', 'asc'))
  // Normalised at the seam: every renderer (gallery, report doc, PDF) reads
  // .dataUrl, whichever era the photo was saved in — and now whether or not the
  // object behind it is encrypted. resolveSubscription fetches and decrypts the
  // sealed ones, hands back blob: URLs under that same field name, and revokes
  // the previous batch on every new snapshot and the last on unsubscribe. An
  // unsealed photo costs nothing: it keeps the `.url` it always had.
  const resolve = resolveSubscription(SEALED_PHOTOS, cb)
  // Field metadata first (captions and filenames are sealed under the policy),
  // then the bytes. Two different keys, two different steps, one field name out.
  const opened = openSnapshots(SEALED_PHOTOS, (rows) => resolve(
    rows.map((r) => ({ ...r, dataUrl: r.dataUrl || r.url || '' })),
  ))
  const stop = onSnapshot(
    q,
    (snap) => opened(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('incident photos', cb),
  )
  return () => { resolve.stop(); stop() }
}

export async function deleteIncidentPhoto(id, photoId) {
  // The doc is the only thing that remembers the cloud path — read it first.
  try {
    const snap = await getDoc(photoRef(id, photoId))
    if (snap.data()?.path) removeFile(snap.data().path)
  } catch { /* orphan tolerated */ }
  await deleteDoc(photoRef(id, photoId))
  await updateDoc(incidentRef(id), { photoCount: increment(-1), updatedAt: serverTimestamp() })
}
