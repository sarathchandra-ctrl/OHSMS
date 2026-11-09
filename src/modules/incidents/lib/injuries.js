// ─────────────────────────────────────────────────────────────────────────────
// Standalone, per-person Injury Reports. Each injury captured inside an incident
// (Step 1a) is reviewed and VERIFIED here, independently of the parent incident.
// Keyed deterministically by `${incidentId}__${personId}` so re-saving an
// incident updates (never dupes). Verification status is preserved across
// re-syncs (we never overwrite it here).
//
// This collection is also the ONLY home of a named colleague's clinical detail —
// body parts, injury type, medication, first-aid detail, days off. It used to be
// a second copy: the same fields rode along on the parent incident as
// injuryReports[]. An ISO 27001 audit found what that meant. /injuries is gated
// to admin and manager precisely to keep the external auditor out, but incidents
// are readable by every approved member AND by the auditor, so one
// getDocs(collection(db,'organizations',ORG,'incidents')) returned the medical
// record of every injured person in the tenant. Gating the second copy was never
// going to work; there is now only one copy, and the incident keeps nothing but
// the key needed to find it.
// ─────────────────────────────────────────────────────────────────────────────
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  limit,
  writeBatch,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
// purgeInjury destroys the clinical DOCUMENTS as well as the pointers to them.
// A pointer deleted without its object leaves the GP letter in the bucket with
// nothing left that names it — unreachable through the app and still there.
import { putFile, removeFile, MAX_INLINE_BYTES, tooLargeForInline } from '../../../shared/storage'
import { resolveSubscription } from '../../../shared/storage/resolveFiles'
import { onReadError } from '../../../shared/org/readError'
import { logAudit } from './firestore'
import { AUDIT } from './audit'
// The clinical fields are sealed under the MEDICAL key class — a keypair, not a
// shared secret, precisely because of the asymmetry this collection is built on:
// a member WRITES an injury report (isWriterOf, through the generic rule) and
// cannot READ one (isManagerOf, the match above it). Sealing with a symmetric
// key would have had to hand every writer the key that opens every colleague's
// record, undoing the gate this file exists to enforce. See
// src/shared/crypto/policy.js.
import { sealDoc, openSnapshots } from '../../../shared/crypto'

/** The collection path shared/crypto/policy.js keys this collection's rules on. */
const SEALED = 'injuries'

const injuryCol = () => collection(db, 'injuries')
const injuryRef = (id) => doc(db, 'injuries', id)
// The clinical documents: GP letters, fit notes, discharge summaries.
//
// The pointer lives here, not under incidents/{id}/photos, because that
// subcollection is listable by every approved member and the auditor, and rules
// cannot filter a list by `kind`. The bytes live under the Storage prefix
// `medical-records`, the one prefix storage.rules withholds from those same
// roles. The collection key `injuries/records` is what shared/crypto/policy.js
// seals with the MEDICAL keypair — the general key would hand the file back to
// every member who can open an incident photo.
//
// MUST stay the same string as MEDICAL_RECORD_KIND in stack/lib/medicalRecords.js
// and the literal in storage.rules. Three copies, three deployable units, no
// import between them.
const SEALED_RECORDS = 'injuries/records'
export const MEDICAL_RECORD_STORAGE_KIND = 'medical-records'
const recordCol = (id) => collection(db, 'injuries', id, 'records')
const recordRef = (injuryId, recordId) =>
  doc(db, 'injuries', injuryId, 'records', recordId)
const incRef = (incidentId) => doc(db, 'incidents', incidentId)
const injuryId = (incidentId, personId) => `${incidentId}__${personId}`

/**
 * Where a Step 1a medical attachment is allowed to go.
 *
 * Null when the ids could not be a Firestore path segment. A slash would let a
 * caller aim the write at a different document, and this function runs before
 * any upload so a bad id never reaches Storage.
 */
export function medicalAttachmentTarget(incidentId, personId) {
  const incident = String(incidentId ?? '').trim()
  const person = String(personId ?? '').trim()
  if (!incident || !person) return null
  if ([incident, person].some((s) => s.includes('/') || s.includes('..') || s.startsWith('__')))
    return null
  return {
    injuryId: injuryId(incident, person),
    storageKind: MEDICAL_RECORD_STORAGE_KIND,
    collection: SEALED_RECORDS,
    incidentId: incident,
    personId: person,
  }
}

// ── What lives where ─────────────────────────────────────────────────────────

/**
 * The clinical fields. These are written to /injuries and to nowhere else — in
 * particular never onto the incident document, which has a far wider audience.
 *
 * `recordFileIds` is on the list although nothing has ever set it (injuryPayload
 * reads report.recordFileIds, which no writer produces, so the Injuries page
 * always shows "—"). It is named here so a dead field cannot quietly be revived
 * on the wrong document.
 *
 * Kept in step with MEDICAL_FIELDS in stack/lib/incidentMedical.js, which
 * strips the same fields off documents written before this split. functions/
 * deploys as its own package and cannot import from src/, so the list exists
 * twice on purpose; change one and change the other.
 */
export const MEDICAL_FIELDS = [
  'bodyParts',
  'injuryType',
  'medication',
  'firstAidDetail',
  'daysToReturnToWork',
  'recordFileIds',
]

/**
 * What an incident may carry about an injured person: enough to find their
 * injury report, and nothing more.
 *
 * `personId` is the join key — the injury doc id is `${incidentId}__${personId}`.
 * `personName` exposes nothing new; the same name is already on the incident as
 * affectedPersonnel[].name. `firstAidDone` is the one judgement call: a boolean
 * "first aid was administered" beside a named person is still a health assertion
 * about them, and if the standard tightens it should move too. It stays for now
 * because it is what Step 1a uses to decide whether a detail field was ever
 * filled in, and nothing but display depends on it.
 */
export const INCIDENT_INJURY_FIELDS = ['personId', 'personName', 'firstAidDone']

/** One injury report as the incident document is allowed to hold it. */
export function incidentInjuryStub(report = {}) {
  return {
    personId: report?.personId || '',
    personName: report?.personName || '',
    firstAidDone: Boolean(report?.firstAidDone),
  }
}

/**
 * Every write of `injuryReports` onto an incident goes through this — see
 * createIncident/updateIncident in incidents.js, which route through it so the
 * contamination cannot come back by way of a caller that forgets. Applying it to
 * an array read back from Firestore also scrubs a document written before the
 * split, which is how existing incidents lose their medical fields on next save.
 */
export const incidentInjuryStubs = (reports = []) =>
  (Array.isArray(reports) ? reports : []).map(incidentInjuryStub)

/**
 * Step 1a's form value: the incident's stubs rehydrated with the clinical detail
 * from /injuries.
 *
 * A caller who cannot read that collection passes an empty list and gets the
 * stubs straight back. That is deliberate — the form must not present blanks it
 * would then save over the top of a colleague's medical record, so the wizard
 * shows those people as recorded-and-hidden rather than editable.
 */
export function mergeInjuryDetail(stubs = [], injuries = []) {
  const byPerson = new Map((injuries || []).filter((j) => j?.personId).map((j) => [j.personId, j]))
  return (stubs || []).map((stub) => {
    const detail = byPerson.get(stub?.personId)
    if (!detail) return { ...stub }
    const out = { ...stub }
    for (const k of MEDICAL_FIELDS) if (k in detail) out[k] = detail[k]
    return out
  })
}

/** Denormalized injury doc body (incident context carried for the standalone list). */
function injuryPayload(incident, report, actor) {
  return {
    incidentId: incident.id,
    incidentRefNo: incident.refNo || '',
    personId: report.personId || '',
    personName: report.personName || '',
    firstAidDone: report.firstAidDone || false,
    firstAidDetail: report.firstAidDetail || '',
    bodyParts: report.bodyParts || [],
    injuryType: report.injuryType || '',
    medication: report.medication || '',
    daysToReturnToWork: report.daysToReturnToWork ?? '',
    recordFileIds: report.recordFileIds || [],
    // Who may edit this report again. A later save by someone else is not a
    // merge of the same record; the rules refuse it. Empty is not "anyone".
    createdBy: actor?.uid || '',
    // incident context (for filtering / display in the standalone page)
    incidentDate: incident.incidentDate || '',
    incidentType: incident.type || '',
    severity: incident.severity || '',
    location: incident.location || '',
    deletedAt: null,
    updatedAt: serverTimestamp(),
  }
}

/**
 * Upsert the incident's injury reports into the standalone collection, and remove
 * any prior injury docs for persons no longer present. Verification fields
 * (status/verifiedBy/verifiedAt) are intentionally omitted so re-syncing never
 * clears a completed verification — a brand-new doc simply has no status, which
 * the UI treats as "pending".
 *
 * EVERY capture path has to come through here, because this is the only writer
 * of clinical detail there is. An entry with no `personId` is skipped below, so
 * a caller that identifies people some other way records nothing — which is
 * exactly what the employee portal did for as long as it wrote its injury
 * capture straight onto the incident under `name`/`uid`.
 */
export async function syncIncidentInjuries(incident, reports = [], actor) {
  // Snapshot existing injuries for this incident so we can (a) protect VERIFIED
  // records from being overwritten and (b) clean up removed persons.
  const verified = new Set()
  let existing = []
  try {
    const snap = await getDocs(query(injuryCol(), where('incidentId', '==', incident.id)))
    existing = snap.docs
    for (const d of snap.docs) if (injuryStatus(d.data()) === 'verified') verified.add(d.id)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[Incident IRA] injury snapshot skipped:', e?.message || e)
  }
  const keep = new Set()
  const pending = []
  for (const r of reports) {
    // No key, no record: the doc id is built from it, so an entry without one
    // cannot be stored or found again. Callers must supply a personId.
    if (!r.personId) continue
    const id = injuryId(incident.id, r.personId)
    keep.add(id)
    if (verified.has(id)) continue // never overwrite a verified injury report
    pending.push({ id, report: r })
  }

  // Sealed and written in PARALLEL. Each of these is an RSA unwrap plus an AES
  // seal per field and then a round trip, and they were awaited one after
  // another — so a fifteen-casualty incident was fifteen sequential seals and
  // fifteen sequential writes, with somebody watching a spinner at the end of
  // the worst day their site has had. The records are independent: one per
  // person, each at its own deterministic id, none reading another.
  //
  // Still not atomic, and this does not pretend otherwise — a failure part-way
  // leaves some people recorded and some not. Making it atomic means a
  // transaction over a variable number of documents, which is a different
  // change; doing them together at least makes the window narrow instead of
  // proportional to the casualty count.
  await Promise.all(
    pending.map(async ({ id, report }) => {
      await setDoc(
        injuryRef(id),
        await sealDoc(SEALED, injuryPayload(incident, report, actor)),
        { merge: true }
      )
    })
  )
  // Cleanup: delete injury docs for this incident whose person was removed
  // (but keep verified ones for the record).
  try {
    await Promise.all(
      existing.filter((d) => !keep.has(d.id) && !verified.has(d.id)).map((d) => deleteDoc(d.ref))
    )
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[Incident IRA] injury cleanup skipped:', e?.message || e)
  }
  await logAudit(actor, AUDIT.INJURY_SYNC, {
    target: 'injury',
    targetId: incident.id,
    targetLabel: incident.refNo || incident.id,
    summary: `${reports.length} injury report(s) saved for verification`,
  })
}

/**
 * Every injury report, deleted ones included.
 *
 * This used to drop soft-deleted rows here, which was right while nothing could
 * soft-delete an injury: the filter had no work to do and the Recycle Bin had
 * nothing to show. Now that deleteInjury exists, dropping them here would hide
 * the record from the ONE screen whose job is to say what is about to be
 * destroyed — a countdown nobody can see is the state the retention sweep was
 * written to end, not to reproduce.
 *
 * So the split moves up to IncidentContext, where the same split already
 * happens for incidents and illnesses. `context.injuries` still means the
 * active ones; `context.deletedInjuries` is the new half. No consumer changes.
 */
export function subscribeInjuries(cb) {
  // Order by updatedAt (every write stamps it); newest first.
  const q = query(injuryCol(), orderBy('updatedAt', 'desc'), limit(2000))
  // openSnapshots decrypts each batch and drops any that is no longer the
  // latest — a busy collection re-emits faster than two thousand records
  // decrypt, and without the guard an older list can land on top of a newer one.
  const opened = openSnapshots(SEALED, cb)
  return onSnapshot(
    q,
    (snap) => opened(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    () => cb([]) // non-fatal: missing index / permissions → empty
  )
}

// Fields a user may edit on a pending injury report.
const EDITABLE = [
  'firstAidDone',
  'firstAidDetail',
  'bodyParts',
  'injuryType',
  'medication',
  'daysToReturnToWork',
]

/**
 * Edit a pending injury report. Rejects if it's already verified. Writes the
 * changes to the standalone injury doc, and mirrors the join key — only the join
 * key — back onto the parent incident. UI-gated to reporter/investigator/admin.
 */
export async function updateInjury(id, fields, actor) {
  const snap = await getDoc(injuryRef(id))
  if (!snap.exists()) throw new Error('Injury report not found')
  // Not opened. Nothing below reads a sealed field off it — `status` and the
  // two join keys are all in the clear — and opening it here would decrypt a
  // colleague's record for an editor who may hold no key at all.
  const cur = snap.data()
  if (injuryStatus(cur) === 'verified')
    throw new Error('This injury report is verified and locked. Unverify it first to make changes.')
  const clean = {}
  for (const k of EDITABLE) if (k in fields) clean[k] = fields[k]
  // `joinable` is taken from the PLAINTEXT edit, below, before this seals it:
  // what goes back onto the incident is governed by the incident's own policy,
  // and a value sealed for /injuries would fail its AAD binding there anyway.
  const sealed = await sealDoc(SEALED, clean)
  await updateDoc(injuryRef(id), { ...sealed, updatedAt: serverTimestamp() })
  // Mirror the join key back onto the incident. This used to spread the whole
  // edit — `{ ...r, ...clean }` — which re-wrote body parts, injury type,
  // medication and days off onto the widely-readable incident document every
  // time anyone saved this page. Rebuilding the array through incidentInjuryStubs
  // both drops the clinical fields from this edit and scrubs any left over from
  // before the split.
  if (cur.incidentId && cur.personId) {
    const joinable = {}
    for (const k of INCIDENT_INJURY_FIELDS) if (k in clean) joinable[k] = clean[k]
    try {
      const isnap = await getDoc(incRef(cur.incidentId))
      if (isnap.exists()) {
        const reports = incidentInjuryStubs(isnap.data().injuryReports).map((r) =>
          r.personId === cur.personId ? { ...r, ...joinable } : r
        )
        await updateDoc(incRef(cur.incidentId), {
          injuryReports: reports,
          updatedAt: serverTimestamp(),
        })
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Incident IRA] injury→incident sync skipped:', e?.message || e)
    }
  }
  // The label used to be `${cur.personName} · ${cur.incidentRefNo}`, and
  // personName is now sealed. Neither available option was to write it here:
  // the ciphertext would put an unreadable string in front of whoever reads the
  // log, and decrypting it would copy a name out of the manager-only collection
  // into /auditLogs, which is a different audience — the same "confine the
  // fields, publish the second copy" mistake this collection was split to fix.
  // The document id and the incident reference find the record and name nobody.
  await logAudit(actor, AUDIT.INJURY_UPDATE, {
    target: 'injury',
    targetId: id,
    targetLabel: cur.incidentRefNo || id,
    summary: 'Injury report edited',
  })
}

/** Mark an injury report verified (or revert to pending). Investigator/admin only (UI-gated). */
export async function setInjuryVerified(id, verified, actor, label) {
  await updateDoc(injuryRef(id), {
    status: verified ? 'verified' : 'pending',
    verifiedBy: verified ? actor?.uid || null : null,
    verifiedByName: verified ? actor?.name || '' : '',
    verifiedAt: verified ? serverTimestamp() : null,
    updatedAt: serverTimestamp(),
  })
  await logAudit(actor, verified ? AUDIT.INJURY_VERIFY : AUDIT.INJURY_UNVERIFY, {
    target: 'injury',
    targetId: id,
    targetLabel: label || id,
    summary: verified ? 'Injury report verified' : 'Injury report verification cleared',
  })
}

/** Status helper: a doc with no explicit status is treated as pending. */
export const injuryStatus = (inj) => (inj?.status === 'verified' ? 'verified' : 'pending')

/**
 * Attach a clinical file to one person's injury report.
 *
 * Scene photos stay on the incident. This is the other writer: the pointer is
 * created under injuries/{injuryId}/records, and the bytes — when the bucket
 * accepts them — under orgs/{orgId}/medical-records, sealed with the medical
 * key class because `collection` is `injuries/records`. A download URL is never
 * stored. getDownloadURL is a bearer link, and copying one onto this pointer
 * would make the storage rule irrelevant to anyone who had seen the string.
 *
 * The parent injury document is created with merge when it is missing, and only
 * with the join keys. Merge, not a blind set: a verified report or a recycle-bin
 * timestamp already on that document must survive an attachment. deletedAt is
 * not written here at all — changing it is what schedules the purge, and a
 * member is not allowed to.
 *
 * The caller may be a member, who can write this and cannot read it back. That
 * is the same asymmetry as the injury report itself. This function does not
 * getDoc the result.
 */
export async function addMedicalRecord(incident, personId, file = {}) {
  const target = medicalAttachmentTarget(incident?.id, personId)
  if (!target)
    throw new Error('A medical record has to name the incident and the person it belongs to.')

  await setDoc(
    injuryRef(target.injuryId),
    await sealDoc(SEALED, {
      incidentId: target.incidentId,
      incidentRefNo: incident?.refNo || '',
      personId: target.personId,
      updatedAt: serverTimestamp(),
    }),
    { merge: true }
  )

  const up = file.dataUrl
    ? await putFile(target.storageKind, file.dataUrl, file.name, {
        collection: target.collection,
      })
    : null
  if (!up && file.dataUrl && (file.size || 0) > MAX_INLINE_BYTES) {
    throw new Error(tooLargeForInline(file.name))
  }

  const pointer = {
    name: file.name || '',
    type: file.type || up?.contentType || '',
    // Inline only when the bucket did not take the bytes. The field is on the
    // medical seal list, so with encryption on it is ciphertext; with encryption
    // off the pointer is still manager-only. Either way it is not an incident photo.
    dataUrl: up ? '' : file.dataUrl || '',
    path: up?.path || '',
    size: file.size || up?.size || 0,
    caption: file.caption || '',
    incidentId: target.incidentId,
    personId: target.personId,
    uploadedBy: file.uploadedBy || '',
    uploadedAt: serverTimestamp(),
  }
  if (up?.encIv) {
    pointer.encScheme = up.encScheme
    pointer.encKeyId = up.encKeyId
    pointer.encIv = up.encIv
    if (up.encWrapped) pointer.encWrapped = up.encWrapped
  }
  const ref = await addDoc(
    recordCol(target.injuryId),
    await sealDoc(SEALED_RECORDS, pointer)
  )
  return ref.id
}

/**
 * The manager view of one injury's clinical files.
 *
 * Ordered by uploadedAt, which is what a record with no timestamp disappears
 * from: Firestore omits documents that lack the ordered field. Callers that
 * are not allowed to read this collection should not subscribe — the error
 * handler returns an empty list, and an empty list here means "nothing was
 * uploaded", which is the wrong sentence for a permission denial.
 */
export function subscribeInjuryRecords(id, cb) {
  if ((!id)) {
    cb([])
    return () => {}
  }
  const q = query(recordCol(id), orderBy('uploadedAt', 'asc'))
  const resolve = resolveSubscription(SEALED_RECORDS, cb)
  const opened = openSnapshots(SEALED_RECORDS, (rows) =>
    resolve(rows.map((r) => ({ ...r, dataUrl: r.dataUrl || r.url || '' })))
  )
  const stop = onSnapshot(
    q,
    (snap) => opened(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('injury records', cb)
  )
  return () => {
    resolve.stop()
    stop()
  }
}

/** Remove one clinical file. Rules allow this to a manager, not to the member who attached it. */
export async function deleteMedicalRecord(id, recordId) {
  const ref = recordRef(id, recordId)
  try {
    const snap = await getDoc(ref)
    if (snap.data()?.path) removeFile(snap.data().path)
  } catch {
    /* the delete below is what the rules decide */
  }
  await deleteDoc(ref)
}

// ── Lifecycle: delete, restore, purge ────────────────────────────────────────
//
// None of this existed. `injuryPayload` wrote `deletedAt: null` and the list
// filtered on it, so the field described a lifecycle that nothing implemented —
// and /injuries, the only home of a named colleague's clinical detail and the
// documents behind it, was the one collection in this app with no way to remove
// a record at all. An ISO 27001 audit found it under A.8.10; the sweep in
// stack/lib/retention.js is the other half, and neither works without both.
//
// Deliberately NOT reached by the incident purge. See the note on the
// `injuries` entry in stack/lib/retention.js for why an injury outliving
// the incident it came from is the intended behaviour rather than the bug.

/**
 * Move an injury report to the Recycle Bin.
 *
 * `deletedAt` is left UNSEALED, like every other structural field on this
 * document. It has to be: the nightly sweep queries on it with the Admin SDK
 * and holds no key, and the list filter reads it before anything decrypts. See
 * the header of shared/crypto/policy.js — a field a query orders or filters on
 * is not a field that can be encrypted.
 *
 * The audit entry names the incident reference and no person. `personName` is
 * sealed under the medical key class, so writing it here would either put
 * ciphertext in front of whoever reads the log or copy a name out of a
 * manager-only collection into /auditLogs, which has a wider audience — the
 * same mistake the injury/incident split was made to correct. Same reasoning as
 * updateInjury above.
 */
export async function deleteInjury(id, actor) {
  const snap = await getDoc(injuryRef(id))
  if (!snap.exists()) return
  // Not opened: nothing below reads a sealed field, and decrypting a
  // colleague's record to delete it would need a key the deleter may not hold.
  const cur = snap.data()
  await updateDoc(injuryRef(id), {
    deletedAt: serverTimestamp(),
    deletedBy: actor?.name || '',
  })
  await logAudit(actor, AUDIT.INJURY_DELETE, {
    target: 'injury',
    targetId: id,
    targetLabel: cur.incidentRefNo || id,
    summary: 'Injury report moved to the recycle bin',
  })
}

/** Take it back out again, with the clock cleared. */
export async function restoreInjury(id, actor) {
  const snap = await getDoc(injuryRef(id))
  if (!snap.exists()) return
  const cur = snap.data()
  await updateDoc(injuryRef(id), {
    deletedAt: null,
    deletedBy: null,
    updatedAt: serverTimestamp(),
  })
  await logAudit(actor, AUDIT.INJURY_RESTORE, {
    target: 'injury',
    targetId: id,
    targetLabel: cur.incidentRefNo || id,
    summary: 'Injury report restored',
  })
}

/**
 * Destroy it now, rather than waiting for the nightly sweep.
 *
 * The `records` subcollection goes FIRST, and its Storage objects go with it.
 * Deleting the parent first would leave the clinical documents addressable only
 * by a path nothing records any more — present in the bucket, absent from every
 * query that could find them again, which is the exact shape of a failed
 * erasure. purgeOrgCollection in functions/index.js orders it the same way, for
 * the same reason.
 *
 * removeFile is fire-and-forget and best-effort, matching purgeIllness: an
 * object already gone is the expected state of a retry. The scheduled sweep is
 * the path that reports a file left behind, because it is the one that runs
 * unattended and can afford to fail an invocation over it.
 */
export async function purgeInjury(id, actor, label) {
  const records = await getDocs(recordCol(id))
  records.docs.forEach((d) => {
    if (d.data().path) removeFile(d.data().path)
  })
  const batch = writeBatch(db)
  records.docs.forEach((d) => batch.delete(d.ref))
  batch.delete(injuryRef(id))
  await batch.commit()
  await logAudit(actor, AUDIT.INJURY_PURGE, {
    target: 'injury',
    targetId: id,
    targetLabel: label || id,
    summary: `Injury report permanently deleted with ${records.size} clinical document(s)`,
  })
}
