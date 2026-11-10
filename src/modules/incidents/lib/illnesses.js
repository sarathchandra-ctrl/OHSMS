// ─────────────────────────────────────────────────────────────────────────────
// Illness reporting data access (occupational health). Standalone records,
// optionally linked to an incident. Corrective actions live embedded and feed
// the cross-source Action Tracker. Files (attachments) live in a base64
// subcollection. Dashboard illness aggregates are derived client-side, so there
// is no stats-counter bucket here — only a running reference-number counter.
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
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { onReadError } from '../../../shared/org/readError'
import { logAudit } from './data'
import { AUDIT, diffSummary } from './audit'
// Reference numbers are issued by the same transactional reserver incidents
// use; only the counter document and the prefix differ.
import { reserveRefNo } from './incidents'
import { reserveDocId } from '../../../shared/docId/reserve'
import { putFile, removeFile, MAX_INLINE_BYTES, tooLargeForInline } from '../../../shared/storage'
// Sealed under the MEDICAL class — the hybrid keypair. /illnesses is readable
// by managers only (isMedical in stack/policy.mjs), while a member may still
// file a report. A symmetric key
// would have had to give every writer the key that opens every record.
import { sealDoc, openDoc, openSnapshots } from '../../../shared/crypto'
import { stampNewAssignees } from '../../../shared/org/stampAssignee'
import { resolveSubscription } from '../../../shared/storage/resolveFiles'

/** Policy keys for this collection and its attachments. See shared/crypto/policy.js. */
const SEALED = 'illnesses'
const SEALED_FILES = 'illnesses/files'

const illnessCol = () => collection(db, 'illnesses')
const illnessRef = (id) => doc(db, 'illnesses', id)
const fileCol = (id) => collection(db, 'illnesses', id, 'files')
const fileRef = (id, fid) => doc(db, 'illnesses', id, 'files', fid)
const counterRef = () => doc(db, 'meta', 'illness')

export const ILLNESS_LOAD_CAP = 2000

export async function createIllness(actor, initial = {}) {
  // Both identifiers are reserved before anything is written, so a failure to
  // issue one leaves no half-created record behind — only an unused number.
  const refNo = await reserveRefNo(counterRef(), 'ILL')
  const docId = await reserveDocId('illnesses')
  const ref = doc(illnessCol())
  const illness = {
    // See createIncident: docId is the org-wide id, refNo is kept for records
    // and correspondence that already quote the older number.
    docId,
    refNo,
    lifecycle: 'reporting',
    stagesDone: { initial: false, actions: false },
    deletedAt: null,
    closedAt: null,
    closedBy: null,
    linkedIncidentId: initial.linkedIncidentId || null,
    // Initial reporting
    affectedPersonnel: initial.affectedPersonnel || [],
    date: initial.date || '',
    time: initial.time || '',
    location: initial.location || '',
    region: initial.region || '',
    entity: initial.entity || '',
    siteId: initial.siteId || '',
    site: initial.site || '',
    exposedToAgent: initial.exposedToAgent || '',
    exposureDuration: initial.exposureDuration || '',
    ppe: initial.ppe || [],
    healthIssue: initial.healthIssue || '',
    affectedBodyParts: initial.affectedBodyParts || [],
    fileCount: 0,
    // Corrective actions
    actions: [],
    createdBy: actor?.uid || null,
    createdByName: actor?.name || '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  await setDoc(ref, await sealDoc(SEALED, illness))
  await logAudit(actor, AUDIT.ILLNESS_CREATE, {
    target: 'illness',
    targetId: ref.id,
    targetLabel: illness.refNo,
    summary: `Illness ${illness.refNo} created`,
  })
  return ref.id
}

export async function updateIllness(id, updates, opts = {}) {
  const current = await getDoc(illnessRef(id))
  if (!current.exists()) throw new Error('Illness not found')
  const before = current.data()
  // Same stamp as updateIncident. Illness action text is health data and is
  // not what gets stamped — only the uid of whoever just set ownerUid.
  const patch = Array.isArray(updates.actions) && opts.actor?.uid
    ? { ...updates, actions: stampNewAssignees(before.actions, updates.actions, opts.actor.uid) }
    : updates
  await updateDoc(illnessRef(id), { ...await sealDoc(SEALED, patch), updatedAt: serverTimestamp() })
  if (!opts.silent) {
    const merged = { ...before }
    for (const [k, v] of Object.entries(updates)) if (!k.includes('.')) merged[k] = v
    await logAudit(opts.actor, opts.action || AUDIT.ILLNESS_UPDATE, {
      target: 'illness',
      targetId: id,
      targetLabel: before.refNo || id,
      summary: opts.summary || diffSummary(before, merged),
    })
  }
}

export async function getIllness(id) {
  const snap = await getDoc(illnessRef(id))
  return snap.exists() ? openDoc(SEALED, { id, ...snap.data() }) : null
}

export function subscribeIllnesses(cb, max = ILLNESS_LOAD_CAP) {
  const q = query(illnessCol(), orderBy('createdAt', 'desc'), limit(max))
  const opened = openSnapshots(SEALED, cb)
  // The fallback goes to `cb`, not to `opened`: there is nothing to unseal, and
  // routing an empty list through the decryption step would report a read
  // failure as a decryption failure.
  return onSnapshot(
    q,
    (snap) => opened(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('illnesses', cb),
  )
}

export async function closeIllness(id, actor) {
  await updateIllness(id, {
    lifecycle: 'closed',
    'stagesDone.actions': true,
    closedAt: serverTimestamp(),
    closedBy: actor?.name || '',
  }, { actor, action: AUDIT.ILLNESS_CLOSE, summary: 'Illness closed' })
}

export async function deleteIllness(id, actor) {
  const snap = await getDoc(illnessRef(id))
  if (!snap.exists()) return
  const before = snap.data()
  await updateDoc(illnessRef(id), { deletedAt: serverTimestamp(), deletedBy: actor?.name || '' })
  await logAudit(actor, AUDIT.ILLNESS_DELETE, { target: 'illness', targetId: id, targetLabel: before.refNo || id })
}

export async function restoreIllness(id, actor) {
  const snap = await getDoc(illnessRef(id))
  if (!snap.exists()) return
  const data = snap.data()
  await updateDoc(illnessRef(id), { deletedAt: null, deletedBy: null, updatedAt: serverTimestamp() })
  await logAudit(actor, AUDIT.ILLNESS_RESTORE, { target: 'illness', targetId: id, targetLabel: data.refNo || id })
}

export async function purgeIllness(id, actor, label) {
  const files = await getDocs(fileCol(id))
  files.docs.forEach((d) => { if (d.data().path) removeFile(d.data().path) })
  const batch = writeBatch(db)
  files.docs.forEach((d) => batch.delete(d.ref))
  batch.delete(illnessRef(id))
  await batch.commit()
  await logAudit(actor, AUDIT.ILLNESS_PURGE, { target: 'illness', targetId: id, targetLabel: label || id })
}

// ── Files (base64 subcollection) ──────────────────────────────────────────────
export async function addIllnessFile(id, file) {
  // Same cloud-first-with-inline-fallback contract as incident photos.
  const up = file.dataUrl
    ? await putFile('illness-files', file.dataUrl, file.name, { collection: SEALED_FILES })
    : null
  if (!up && file.dataUrl && (file.size || 0) > MAX_INLINE_BYTES) {
    throw new Error(tooLargeForInline(file.name))
  }
  const ref = await addDoc(fileCol(id), await sealDoc(SEALED_FILES, {
    name: file.name || '',
    type: file.type || '',
    dataUrl: up ? '' : file.dataUrl,
    url: up?.url || '',
    path: up?.path || '',
    size: file.size || 0,
    caption: file.caption || '',
    uploadedBy: file.uploadedBy || '',
    uploadedAt: serverTimestamp(),
    ...(up?.encIv ? { encScheme: up.encScheme, encKeyId: up.encKeyId, encIv: up.encIv, ...(up.encWrapped ? { encWrapped: up.encWrapped } : {}) } : {}),
  }))
  await updateDoc(illnessRef(id), { fileCount: increment(1), updatedAt: serverTimestamp() })
  return ref.id
}

export function subscribeIllnessFiles(id, cb) {
  const q = query(fileCol(id), orderBy('uploadedAt', 'asc'))
  // Opened BEFORE the dataUrl normalisation, not after: the inline copy is
  // sealed, so `data.dataUrl || data.url` run first would see an envelope, find
  // it truthy, and hand the renderer a base64 string in place of an image.
  const resolve = resolveSubscription(SEALED_FILES, cb)
  const opened = openSnapshots(SEALED_FILES, (rows) => resolve(
    rows.map((r) => ({ ...r, dataUrl: r.dataUrl || r.url || '' })),
  ))
  const stop = onSnapshot(
    q,
    (snap) => opened(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('illness attachments', cb),
  )
  return () => { resolve.stop(); stop() }
}

export async function deleteIllnessFile(id, fileId) {
  try {
    const snap = await getDoc(fileRef(id, fileId))
    if (snap.data()?.path) removeFile(snap.data().path)
  } catch { /* orphan tolerated */ }
  await deleteDoc(fileRef(id, fileId))
  await updateDoc(illnessRef(id), { fileCount: increment(-1), updatedAt: serverTimestamp() })
}
