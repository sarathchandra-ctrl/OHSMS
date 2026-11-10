// ─────────────────────────────────────────────────────────────────────────────
// All Firestore access goes through here: org-scoped paths, batch helpers, and
// the public QR mirror kept in sync with every extinguisher write.
// ─────────────────────────────────────────────────────────────────────────────
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc as _setDoc,
  addDoc as _addDoc,
  updateDoc as _updateDoc,
  deleteDoc as _deleteDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  writeBatch as _writeBatch,
  runTransaction as _runTransaction,
  limit,
  increment,
  where,
  deleteField,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { isSessionEnd } from '../../../shared/sessionEnd'
import { todayISO } from '../../../shared/lib/dates'

// ── Read-only demo guard ─────────────────────────────────────────────────────
// When the demo account is signed in, every Firestore write is blocked
// client-side so the shared sample data stays pristine for the next visitor.
// Reads (subscribe*/get*/list*/query*) are untouched. Wrapping the write
// primitives here means ALL mutations are covered without touching each helper.
let READ_ONLY = false
export const DEMO_READONLY_MESSAGE = "You're in the read-only demo — sign up to make changes."
function assertWritable() {
  if (READ_ONLY) throw new Error(DEMO_READONLY_MESSAGE)
}
const setDoc = (...args) => { assertWritable(); return _setDoc(...args) }
const addDoc = (...args) => { assertWritable(); return _addDoc(...args) }
const updateDoc = (...args) => { assertWritable(); return _updateDoc(...args) }
const deleteDoc = (...args) => { assertWritable(); return _deleteDoc(...args) }
const writeBatch = (...args) => { assertWritable(); return _writeBatch(...args) }
// Wrapped like its neighbours, and not optional: a transaction writes through
// none of the primitives above, so the demo guard would have had a hole in it
// the size of every transactional path added from here on.
const runTransaction = (...args) => { assertWritable(); return _runTransaction(...args) }
import { generateQrToken, tokenFromQrValue } from './qr'
import {
  fasQrTokenForCreate,
  fasQrTokenForUpdate,
  isFasControlPanel,
  planFasPanelQrBackfill,
} from './fasQr'
import { restoreBlockMessage, EQUIPMENT_KINDS } from './recycle'
import { STATUS, DEFECT_BY_KEY, PHYSICAL_DEFECT_KEYS, SIGNAGE_STATUSES } from './constants'
import { deployedRequirementErrors, signagePhotos } from './signageLogic'
import { lockId, duplicateDefectMessage } from './defectLock'
import { putFile, removeFile, MAX_INLINE_BYTES, tooLargeForInline } from '../../../shared/storage'
import { reserveDocId, reserveSeq } from '../../../shared/docId/reserve'
import { reportError } from '../../../shared/monitoring'
import { discardMailedReport } from '../../../shared/print/mailedReport'
import { AUDIT, diffSummary } from './audit'
import { logAudit as logOrgAudit, auditCol, COLLECTION_READ_CAP } from '../../../shared/org/orgData'
import { onReadError } from '../../../shared/org/readError'
import {
  hptUpdate,
  hptSummary,
  isHptOverdue,
  HPT_BLOCKS_RESOLVE,
  HPT_BLOCKS_VENDOR,
  resolveBlockReason,
} from './hpt'
import {
  CLOSURE_SOURCE,
  assetClosureDoc,
  closureFields,
  extinguisherCloseUpdate,
  extinguisherClosureDoc,
  receiveClosures,
  validateClosure,
  cleanClosurePhoto,
} from './defectClosure'
import {
  hptDateUnchanged,
  receiveFromVendorUpdate,
  validateRefilledClosed,
  validateRefilledHpt,
} from './receive'
import { formatAssetId } from './assetLogic'
import { statsDeltaFor, accumulate } from './stats'
import { reportEffect } from './reportEffect'
// Mock drills name the incident commander, the people alerted, and what the
// debrief said about them. Sealed under the GENERAL class — every approved
// member may read a drill record. What stays readable is what the scorecard and
// the KPI roll-ups group by: score, outcome, eventType, scenario, the timings.
import { sealDoc, openDocs, openSnapshots } from '../../../shared/crypto'
import { resolveSealedFiles } from '../../../shared/storage/resolveFiles'

/** Policy keys for the drill collections. See src/shared/crypto/policy.js. */
const SEALED_DRILLS = 'mockDrills'
const SEALED_DRILL_PHOTOS = 'mockDrills/photos'

// ── Path helpers ─────────────────────────────────────────────────────────────
const orgRef = () => doc(db, 'organization', 'profile')
const extCol = () => collection(db, 'extinguishers')
const extRef = (id) => doc(db, 'extinguishers', id)
const reportCol = () => collection(db, 'reports')
const closureCol = () => collection(db, 'defectClosures')
const reportRef = (id) => doc(db, 'reports', id)
const defectLockRef = (extId, defectType) =>
  doc(db, 'defectLocks', lockId(extId, defectType))
const qrRef = (token) => doc(db, 'qr', token)
const statsRef = () => doc(db, 'meta', 'stats')
const signageCol = () => collection(db, 'signages')
const signageRef = (id) => doc(db, 'signages', id)
const drillCol = () => collection(db, 'mockDrills')
const drillRef = (id) => doc(db, 'mockDrills', id)
const aedCol = () => collection(db, 'aeds')
const aedRef = (id) => doc(db, 'aeds', id)
const fasCol = () => collection(db, 'fas')
const fasRef = (id) => doc(db, 'fas', id)
const firstAidCol = () => collection(db, 'firstAid')
const firstAidRef = (id) => doc(db, 'firstAid', id)
const stretcherCol = () => collection(db, 'stretchers')
const stretcherRef = (id) => doc(db, 'stretchers', id)
// Mock-drill evidence photos live in a per-drill subcollection (one doc each, ≤~700 KB)
// so the live drill list never carries the image blobs.
const drillPhotoCol = (drillId) => collection(db, 'mockDrills', drillId, 'photos')

// ── Audit log ──────────────────────────────────────────────────────────────────
// The trail is written by ONE implementation, in shared/org/orgData. This
// wrapper adds only what is specific to this module.
//
// The private copy it replaces omitted `module`, and Admin → Audit Log renders
// MODULE_BY_KEY[l.module] — so every entry the fleet wrote displayed as "Core",
// and the log could not be filtered back to the module that produced it. Drill
// writes pass module: 'drills' at the call site; this file serves both keys.
const logAudit = (actor, action, details = {}) =>
  logOrgAudit(actor, action, { module: 'equipment', target: 'extinguisher', ...details })

export function subscribeAuditLogs(cb) {
  const q = query(auditCol(), orderBy('at', 'desc'), limit(200))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('the fire audit log', cb),
  )
}

// ── Stats counters (organizations/{orgId}/meta/stats) ────────────────────────
// Maintained atomically inside each mutation batch so the dashboard's structural
// totals are exact fleet-wide regardless of the 2,000 load cap.

// Apply a sparse delta object (from statsDeltaFor) to the stats counter doc as
// increment() field updates, flattened to dotted paths (e.g. "byStatus.active").
//
// IMPORTANT: this is fire-and-forget and NON-BLOCKING — it runs in its own write,
// AFTER the primary data batch has committed, and never throws. The dashboard
// stats are a convenience overlay; a stats write failing (e.g. rules not yet
// published for meta/stats) must never block or roll back the real extinguisher
// write. (Same philosophy as logAudit.)
async function bumpStats(delta) {
  if (!delta) return
  const fields = {}
  if (delta.total) fields.total = increment(delta.total)
  for (const bucket of ['byStatus', 'byType', 'byEntity', 'byRegion']) {
    const m = delta[bucket]
    if (!m) continue
    for (const k of Object.keys(m)) {
      if (m[k]) fields[`${bucket}.${k}`] = increment(m[k])
    }
  }
  if (Object.keys(fields).length === 0) return
  fields.updatedAt = serverTimestamp()
  try {
    // set(merge) so the doc is created on first write and increments thereafter.
    await setDoc(statsRef(), fields, { merge: true })
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[Fire Marshal] stats update skipped:', e?.message || e)
  }
}

export function subscribeStats(cb) {
  return onSnapshot(
    statsRef(),
    (snap) => cb(snap.exists() ? snap.data() : null),
    // null, not [] — the dashboard reads this as one document and falls back to
    // counting the loaded page when it is absent.
    onReadError('the extinguisher counters', cb, null),
  )
}

/** Full recompute from a one-time read of all extinguishers (admin Refresh / backfill). */
export async function recomputeStats() {
  const snap = await getDocs(extCol())
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  const s = accumulate(list)
  await setDoc(statsRef(), { ...s, updatedAt: serverTimestamp() })
  return s
}

const extLabelOf = (ext) =>
  ext?.serialNo ? `${ext.serialNo} · ${ext.type || ''}`.trim() : `${ext?.type || ''} · ${ext?.capacity || ''}`

// ── Organizations & users ─────────────────────────────────────────────────────


// Delegated to the shared ref-counted users listener (one app-wide).
export { subscribeOrgUsers } from '../../../shared/org/orgData'

/** Live org document. */
export function subscribeOrg(cb) {
  return onSnapshot(
    orgRef(),
    (snap) => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onReadError('the organization', cb, null),
  )
}

// ── QR mirror ──────────────────────────────────────────────────────────────────
// Minimal public-readable copy of an extinguisher, keyed by qrToken.
function mirrorPayload(orgName, id, ext) {
  return {
    orgName: orgName || '',
    extId: id,
    token: ext.qrToken,
    // Every field is defaulted: Firestore rejects `undefined`, and assets that
    // predate a column (or arrived by import) legitimately lack one. The add
    // path always supplies them, but backfilling existing stock does not.
    serialNo: ext.serialNo || '',
    type: ext.type || '',
    capacity: ext.capacity || '',
    entity: ext.entity || '',
    region: ext.region || '',
    centerName: ext.centerName || '',
    dateOfDeployment: ext.dateOfDeployment || '',
    dateOfNextRefill: ext.dateOfNextRefill || '',
    dateOfNextHPT: ext.dateOfNextHPT || '',
    status: ext.status || '',
    physicalDefects: ext.physicalDefects || [],
    // Null on a live unit, set while it sits in the bin. Omitting it on a
    // rewrite would publish a retired unit as in service. The field is on the
    // rules allow-list for the same reason.
    deletedAt: ext.deletedAt || null,
    updatedAt: serverTimestamp(),
  }
}

// ── Extinguishers ──────────────────────────────────────────────────────────────

/** Add a single extinguisher + its public QR mirror. Returns {id, qrToken}. */
export async function addExtinguisher(orgName, data, actor) {
  const ref = doc(extCol())
  // Adopt a code the site has already printed, exactly as the CSV import does.
  // The add form offers a QR Link field for the same reason imports accept one:
  // stock frequently arrives with labels already stuck on, and minting a fresh
  // token here would mean every one of those labels scans to nothing.
  const qrToken = tokenFromQrValue(data.qrToken || data.qrLink) || generateQrToken()
  const ext = {
    serialNo: data.serialNo || '',
    type: data.type,
    capacity: data.capacity,
    entity: data.entity,
    region: data.region || '',
    centerName: data.centerName,
    // The form carries these and SiteScopePicker fills them, but this object
    // literal used to drop them, so every unit added here was created unlinked
    // and the backlog grew faster than any repair pass could clear it. AEDs and
    // FAS already carry the same line, with the same comment, for the same
    // reason -- see cleanAed and cleanFas below.
    siteId: data.siteId || '',
    siteName: data.site || data.centerName || '',
    dateOfDeployment: data.dateOfDeployment || '',
    dateOfNextRefill: data.dateOfNextRefill || '',
    dateOfNextHPT: data.dateOfNextHPT || '',
    status: STATUS.ACTIVE,
    physicalDefects: [],
    deletedAt: null,
    qrToken,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  const batch = writeBatch(db)
  batch.set(ref, ext)
  batch.set(qrRef(qrToken), mirrorPayload(orgName, ref.id, ext))
  await batch.commit()
  await bumpStats(statsDeltaFor(null, ext))
  await logAudit(actor, AUDIT.EXT_CREATE, {
    targetId: ref.id,
    targetLabel: extLabelOf(ext),
    summary: `${ext.type} ${ext.capacity} @ ${ext.centerName}`,
  })
  return { id: ref.id, qrToken }
}

/**
 * Give extinguishers that have no QR code one, and publish their public mirror.
 *
 * Assets that predate the QR system — imported, seeded, or created before it
 * existed — carry no token, so "Print QR" produced nothing for them and a scan
 * could never resolve. Backfills only what is missing; an existing token is
 * left alone so labels already on the wall keep working.
 *
 * Returns the number of assets given a code.
 */
export async function backfillExtinguisherQr(orgName, extinguishers, actor) {
  const missing = extinguishers.filter((e) => !e.qrToken && !e.deletedAt)
  if (!missing.length) return 0
  // Each asset is 2 writes, so chunk well inside the 500-op batch limit.
  for (let i = 0; i < missing.length; i += 200) {
    const batch = writeBatch(db)
    for (const asset of missing.slice(i, i + 200)) {
      const qrToken = generateQrToken()
      batch.update(extRef(asset.id), { qrToken, updatedAt: serverTimestamp() })
      batch.set(qrRef(qrToken), mirrorPayload(orgName, asset.id, { ...asset, qrToken }))
    }
    await batch.commit()
  }
  await logAudit(actor, AUDIT.EXT_UPDATE, {
    summary: `Generated QR codes for ${missing.length} extinguisher(s) that had none`,
  })
  return missing.length
}

/**
 * Attach extinguishers to the site registry.
 *
 * Writes the resolved siteId and takes entity from the linked site, which is
 * the system of record for what a site is. The public QR mirror carries entity
 * too, so it is rewritten in the same batch — otherwise a scanned label would
 * keep showing the old value.
 *
 * `plan` comes from planSiteLinks(); nothing here decides what matches.
 */
export async function linkExtinguishersToSites(orgName, plan, actor) {
  const items = plan.linked
  if (!items.length) return { linked: 0, entityChanges: 0 }

  // Two writes per asset, so chunk well inside the 500-op batch limit.
  for (let i = 0; i < items.length; i += 200) {
    const batch = writeBatch(db)
    for (const { ext, site } of items.slice(i, i + 200)) {
      // A site record is not obliged to carry a name or an entity, and Firestore
      // rejects an undefined field value outright — so one registry row with a
      // blank entity threw before the first batch committed and took the whole
      // link action down with a message about "invalid data", naming a document
      // id and nothing a reader could act on. Coerce, and a blank stays blank.
      const siteName = site.name || ''
      const entity = site.entity || ''
      const merged = { ...ext, siteId: site.id, siteName, entity }
      batch.update(extRef(ext.id), {
        siteId: site.id,
        siteName,
        entity,
        updatedAt: serverTimestamp(),
      })
      if (ext.qrToken) batch.set(qrRef(ext.qrToken), mirrorPayload(orgName, ext.id, merged))
    }
    await batch.commit()
  }

  await logAudit(actor, AUDIT.EXT_UPDATE, {
    summary: `Linked ${items.length} extinguisher(s) to sites; ${plan.entityChanges} entity value(s) corrected from the site registry`,
  })
  return { linked: items.length, entityChanges: plan.entityChanges }
}

// Spec/date fields safe to overwrite on a CSV upsert (NOT status/defects/qrToken).
const UPSERT_FIELDS = [
  'type',
  'capacity',
  'entity',
  'region',
  'centerName',
  // Carried on an upsert too, so re-importing an export does not strip a link
  // a repair pass just established.
  'siteId',
  'siteName',
  'serialNo',
  'dateOfDeployment',
  'dateOfNextRefill',
  'dateOfNextHPT',
]

/**
 * Bulk create + update from a CSV import.
 *  - creates: new extinguisher rows (each gets a fresh qrToken + mirror).
 *  - updates: [{ id, qrToken, ...data }] — overwrites spec/date fields only,
 *    preserving status, physicalDefects and the existing qrToken; mirror rewritten.
 * Returns { created, updated } counts.
 */
export async function bulkUpsertExtinguishers(orgName, { creates = [], updates = [] }, actor) {
  let created = 0
  let updated = 0

  // ── Creates (chunked: 2 writes each) ──
  for (let i = 0; i < creates.length; i += 200) {
    const chunk = creates.slice(i, i + 200)
    const batch = writeBatch(db)
    for (const data of chunk) {
      const ref = doc(extCol())
      // Reuse a QR code the site already has printed, when the upload supplied
      // one; otherwise mint a fresh token.
      const qrToken = data.qrToken || generateQrToken()
      const ext = {
        serialNo: data.serialNo || '',
        type: data.type,
        capacity: data.capacity,
        entity: data.entity,
        region: data.region || '',
        centerName: data.centerName,
        // Same omission as addExtinguisher had: a CSV can carry a resolved site,
        // and dropping it here is why a bulk upload of hundreds of units left
        // every one of them unlinked.
        siteId: data.siteId || '',
        siteName: data.site || data.centerName || '',
        dateOfDeployment: data.dateOfDeployment || '',
        dateOfNextRefill: data.dateOfNextRefill || '',
        dateOfNextHPT: data.dateOfNextHPT || '',
        // Migrated rows may arrive already flagged; a fresh row defaults to active.
        status: data.status || STATUS.ACTIVE,
        physicalDefects: Array.isArray(data.physicalDefects) ? data.physicalDefects : [],
        deletedAt: null,
        qrToken,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }
      batch.set(ref, ext)
      batch.set(qrRef(qrToken), mirrorPayload(orgName, ref.id, ext))
      created++
    }
    await batch.commit()
  }

  // ── Updates (spec/date only; keep status/defects/qrToken) ──
  for (let i = 0; i < updates.length; i += 200) {
    const chunk = updates.slice(i, i + 200)
    const batch = writeBatch(db)
    for (const row of chunk) {
      const fields = {}
      for (const k of UPSERT_FIELDS) {
        if (row[k] !== undefined) fields[k] = row[k] || ''
      }
      fields.updatedAt = serverTimestamp()
      batch.update(extRef(row.id), fields)
      if (row.qrToken) {
        // Mirror needs the full picture; carry preserved status/defects too.
        const merged = {
          ...row,
          qrToken: row.qrToken,
          status: row.status,
          physicalDefects: row.physicalDefects || [],
        }
        batch.set(qrRef(row.qrToken), mirrorPayload(orgName, row.id, merged))
      }
      updated++
    }
    await batch.commit()
  }

  // Updates can shift type/entity/region buckets (and creates add rows); a full
  // recompute is the simplest correct way to reconcile both in one pass. Stats
  // are a convenience overlay — never let a stats write block the import.
  await recomputeStats().catch((e) => console.warn('[Fire Marshal] stats recompute skipped:', e?.message || e))
  await logAudit(actor, AUDIT.EXT_BULK_UPSERT, {
    summary: `Bulk import: ${created} added, ${updated} updated`,
  })
  return { created, updated }
}

/**
 * Update an extinguisher and keep its QR mirror in sync.
 * `opts` = { actor, action, summary } drives the audit entry. Defaults to a
 * field-level diff under the generic "edit" action.
 */
export async function updateExtinguisher(orgName, id, updates, opts = {}) {
  const current = await getDoc(extRef(id))
  if (!current.exists()) throw new Error('Extinguisher not found')
  const before = current.data()
  const merged = { ...before, ...updates }
  const batch = writeBatch(db)
  batch.update(extRef(id), { ...updates, updatedAt: serverTimestamp() })
  if (merged.qrToken) {
    batch.set(qrRef(merged.qrToken), mirrorPayload(orgName, id, merged))
  }
  // Closures ride in this commit. A status that lands without the closure
  // document would take the defect off the open list and leave the Closed
  // filter with nothing to show, and the reverse would show a close the unit
  // had not actually had.
  if (opts.withBatch) opts.withBatch(batch)
  await batch.commit()
  await bumpStats(statsDeltaFor(before, merged))
  if (!opts.silent) {
    await logAudit(opts.actor, opts.action || AUDIT.EXT_UPDATE, {
      targetId: id,
      targetLabel: extLabelOf(merged),
      summary: opts.summary || diffSummary(before, updates),
    })
  }
}

// The bin keeps the asset AND its public QR mirror. Deleting the mirror here
// is what made a scan say "code not recognised" — the same sentence as a
// sticker we never printed — so a delete looked permanent. The mirror is
// marked deleted instead, and the scan page says so. Purge, thirty days on
// or from the bin, is what actually removes it.
//
// A missing mirror is left missing. set-merge on a token that has no document
// is a create, and a create of `{deletedAt}` alone fails the mirror shape
// rule and takes the whole batch with it.
async function retireAssets(items, refOf, actor) {
  const list = (items || []).filter((it) => it && it.id)
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200)
    const mirrors = await Promise.all(chunk.map(async (it) => {
      if (!it.qrToken) return false
      const snap = await getDoc(qrRef(it.qrToken))
      return snap.exists()
    }))
    const batch = writeBatch(db)
    chunk.forEach((it, n) => {
      batch.update(refOf(it.id), {
        deletedAt: serverTimestamp(),
        deletedBy: actor?.name || '',
        deletedByUid: actor?.uid || '',
      })
      if (mirrors[n]) batch.set(qrRef(it.qrToken), { deletedAt: serverTimestamp() }, { merge: true })
    })
    await batch.commit()
  }
}

// Live units that already hold this code or this token. Deleted rows are
// ignored: they are the ones being restored. The query is case-sensitive,
// which matches the value stored on the document.
async function liveHolding(colOf, field, value, exceptId) {
  const v = String(value || '').trim()
  if (!v) return []
  const snap = await getDocs(query(colOf(), where(field, '==', v), limit(8)))
  return snap.docs
    .filter((d) => d.id !== exceptId && !d.data().deletedAt)
    .map((d) => ({ id: d.id, ...d.data() }))
}

async function reviveAssets(orgName, kind, ids, actor, { refOf, colOf, mirror, audit, labelOf }) {
  const spec = EQUIPMENT_KINDS[kind]
  const rows = []
  for (const id of ids || []) {
    const snap = await getDoc(refOf(id))
    if (!snap.exists()) throw new Error('That record is no longer there.')
    const data = { id, ...snap.data() }
    if (!data.deletedAt) throw new Error('That record is already active.')
    rows.push(data)
  }
  if (!rows.length) return
  const live = []
  for (const row of rows) {
    live.push(...await liveHolding(colOf, spec.codeField, row[spec.codeField], row.id))
    live.push(...await liveHolding(colOf, 'qrToken', row.qrToken, row.id))
  }
  const blocked = restoreBlockMessage(rows, live, kind)
  if (blocked) throw new Error(blocked)
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200)
    const batch = writeBatch(db)
    for (const data of chunk) {
      batch.update(refOf(data.id), {
        deletedAt: null,
        deletedBy: null,
        deletedByUid: null,
        updatedAt: serverTimestamp(),
      })
      if (data.qrToken) {
        batch.set(qrRef(data.qrToken), mirror(orgName, data.id, { ...data, deletedAt: null }))
      }
    }
    await batch.commit()
  }
  await logAudit(actor, audit, {
    summary: rows.length === 1 ? `${labelOf(rows[0])} restored` : `${rows.length} restored`,
    targetId: rows.length === 1 ? rows[0].id : '',
    targetLabel: rows.length === 1 ? labelOf(rows[0]) : '',
  })
  return rows
}

/** Bulk soft-delete extinguishers by [{id, qrToken}]. The QR mirror stays. */
export async function bulkDeleteExtinguishers(items, actor) {
  await retireAssets(items, extRef, actor)
  await recomputeStats().catch((e) => console.warn('[Fire Marshal] stats recompute skipped:', e?.message || e))
  await logAudit(actor, AUDIT.EXT_BULK_DELETE, {
    summary: `${items.length} extinguisher(s) moved to Recently deleted`,
  })
}

/** Restore one or several. Same document, same QR token, history untouched. */
export async function restoreExtinguishers(orgName, ids, actor) {
  const rows = await reviveAssets(orgName, 'extinguisher', ids, actor, {
    refOf: extRef,
    colOf: extCol,
    mirror: mirrorPayload,
    audit: AUDIT.EXT_RESTORE,
    labelOf: extLabelOf,
  })
  for (const data of rows || []) {
    await bumpStats(statsDeltaFor(null, { ...data, deletedAt: null }))
  }
}

/** Restore a soft-deleted extinguisher: clear deletedAt and republish the QR mirror. */
export async function restoreExtinguisher(orgName, id, actor) {
  return restoreExtinguishers(orgName, [id], actor)
}

/** Permanently delete a soft-deleted extinguisher (admin only — enforced by rules). */
export async function purgeExtinguisher(id, qrToken, actor, label) {
  const batch = writeBatch(db)
  batch.delete(extRef(id))
  if (qrToken) batch.delete(qrRef(qrToken))
  await batch.commit()
  await logAudit(actor, AUDIT.EXT_PURGE, { targetId: id, targetLabel: label || '' })
}

// Max records loaded into the live in-memory set. The dashboard and all lists
// derive from these sets client-side, so they are capped for scale.
//
// This used to be a private 2000 while reports and mock drills capped at 1000
// and signage, AEDs and FAS at 2000 — five different silent ceilings, only ONE
// of which (extinguishers) ever told anyone it had been reached. An org past
// 1000 drills saw a dashboard built on the most recent 1000 and no indication
// of it. They are now all COLLECTION_READ_CAP, the same ceiling the rest of the
// app uses, and FleetContext reports every one of them through the shared
// incompleteReadNotice.
export const EXT_LOAD_CAP = COLLECTION_READ_CAP

export function subscribeExtinguishers(cb, max = EXT_LOAD_CAP) {
  const q = query(extCol(), orderBy('createdAt', 'desc'), limit(max))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('extinguishers', cb),
  )
}

/**
 * One-time migration: older extinguishers created before soft-delete don't have
 * a `deletedAt` field at all, so the Repository's server query
 * `where('deletedAt','==',null)` skips them (Firestore == null does NOT match a
 * missing field). Backfill `deletedAt: null` on any loaded doc missing it so it
 * becomes visible to the paginated query. Silent (no audit — it's a migration).
 * Returns the number of docs fixed. Runs only for docs where the field is
 * strictly `undefined` (absent) — never touches explicitly soft-deleted docs.
 */
export async function backfillDeletedAt(list = []) {
  const missing = list.filter((e) => e && e.id && e.deletedAt === undefined)
  if (!missing.length) return 0
  for (let i = 0; i < missing.length; i += 400) {
    const chunk = missing.slice(i, i + 400)
    const batch = writeBatch(db)
    for (const e of chunk) batch.update(extRef(e.id), { deletedAt: null })
    await batch.commit()
  }
  return missing.length
}

export const PAGE_SIZE = 50

export async function getExtinguisher(id) {
  const snap = await getDoc(extRef(id))
  return snap.exists() ? { id, ...snap.data() } : null
}

// ── Public QR ───────────────────────────────────────────────────────────────────

// ── Reports (approval queue) ──────────────────────────────────────────────────

/**
 * Submit a report (defect or status change). Works for authenticated portal
 * users AND public QR visitors. Always lands as `pending`.
 */
export async function createReport(report) {
  // One open report per defect per unit. The lock document and the report are
  // written together, so a duplicate cannot slip through between the check and
  // the write, and the QR page — which may not read reports — is covered by the
  // same rule as the portal.
  if (report.kind === 'defect' && report.defectType) {
    const batch = writeBatch(db)
    batch.set(defectLockRef(report.extId, report.defectType), {
      extId: report.extId,
      defectType: report.defectType,
      createdAt: serverTimestamp(),
      // The scanned token. A public reporter has no account, so this is the only
      // evidence they were ever near the unit — the rules require it to name
      // this exact extinguisher, which is what stops a stranger pre-creating
      // locks and silently suppressing everyone else's defect reports.
      token: report.token || '',
    })
    batch.set(doc(reportCol()), reportPayload(report))
    try {
      await batch.commit()
    } catch (e) {
      if (e?.code !== 'permission-denied') throw e

      // Somebody just failed to report a safety defect. Whatever the cause,
      // that must reach an operator — this exact failure once looked like a
      // duplicate for a day because the only signal was a hedged sentence on a
      // phone in a corridor, and nothing anywhere else.
      reportError(e, {
        where: 'createReport',
        extId: report.extId,
        defectType: report.defectType,
        source: report.source,
        hasToken: Boolean(report.token),
      })

      // A duplicate is only the LIKELIEST cause. When the caller can read the
      // lock collection we can stop guessing and say which it actually was; a
      // public reporter cannot, and gets the hedged message that assumes the
      // common case without asserting it.
      const label = DEFECT_BY_KEY[report.defectType]?.label || 'That defect'
      let locked = null
      try {
        locked = (await getDoc(defectLockRef(report.extId, report.defectType))).exists()
      } catch {
        locked = null // not permitted to look — anonymous scan
      }

      if (locked === false) {
        // Certain it is not a duplicate, so saying so would be a lie. Whatever
        // refused this is a fault on our side, and the reporter needs to know
        // the defect is NOT recorded.
        throw new Error(
          `${label} could not be reported — the system refused it, and it has NOT been logged. ` +
          `Tell your safety team directly. This has been reported to the administrators.`
        )
      }
      throw new Error(duplicateDefectMessage(label))
    }
    await logReportCreated(report)
    return
  }

  await addDoc(reportCol(), reportPayload(report))
  await logReportCreated(report)
}

function reportPayload(report) {
  return {
    extId: report.extId,
    extLabel: report.extLabel || '',
    kind: report.kind, // 'defect' | 'status_change'
    defectType: report.defectType || null,
    newStatus: report.newStatus || null,
    note: report.note || '',
    reportedBy: report.reportedBy || 'public',
    reportedByName: report.reportedByName || 'QR Scan (Public)',
    reporterRole: report.reporterRole || null,
    source: report.source || 'portal',
    approvalStatus: 'pending',
    reportedAt: serverTimestamp(),
    // Proof of scan. The rules require a public report to carry the token of
    // the very asset it names, so orgId and extId stop being strings an
    // anonymous writer can invent. Members are authorised without it, but it
    // costs nothing to send and keeps both paths identical.
    token: report.token || '',
  }
}

function logReportCreated(report) {
  const what = report.kind === 'defect' ? `defect (${report.defectType})` : `status → ${report.newStatus}`
  return logAudit({ uid: report.reportedBy, name: report.reportedByName }, AUDIT.REPORT_CREATE, {
    target: 'report',
    targetLabel: report.extLabel || report.extId,
    summary: `Reported ${what}${report.reporterRole ? ` (by ${report.reporterRole})` : ''}`,
    source: report.source || 'portal',
  })
}

export function subscribeReports(cb) {
  const q = query(reportCol(), orderBy('reportedAt', 'desc'), limit(COLLECTION_READ_CAP))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('defect reports', cb),
  )
}

/**
 * Approve a report and apply its effect to the extinguisher:
 *  - defect that triggers refill  → add defect + set status TO_BE_REFILLED
 *  - physical defect              → add defect (status unchanged)
 *  - status_change                → set the requested status
 */
export async function approveReport(orgName, report, reviewerName, actor) {
  // ── Why this is a transaction and not two awaits ────────────────────────────
  //
  // It used to getExtinguisher(), build a Set of physicalDefects and write the
  // whole array back through updateExtinguisher. Two approvers working the
  // pending queue — which is how that screen is used — each read the same array
  // and each wrote their own version, so one reported fault was silently lost
  // and `status` might never flip to TO_BE_REFILLED. Both are safety-visible:
  // the fault stops being on the unit's record, and the unit stops being in the
  // refill queue.
  //
  // arrayUnion() alone would not have been enough. The mirror payload and the
  // stats delta are both derived from a locally merged object, and a sentinel
  // passed through those would poison the public QR page and the dashboard
  // counters. Reading inside the transaction keeps the merge a plain object and
  // makes it current at the same time.
  //
  // The REPORT is read here too, so approving the same one twice is refused
  // rather than double-counted into meta/stats — the defect set is idempotent
  // but the counters are not.
  const extReference = extRef(report.extId)
  const reportReference = reportRef(report.id)
  let before = null
  let merged = null

  await runTransaction(db, async (tx) => {
    const rSnap = await tx.get(reportReference)
    if (!rSnap.exists()) throw new Error('That report no longer exists.')
    if (rSnap.data().approvalStatus === 'approved') {
      throw new Error('That report has already been approved.')
    }
    const eSnap = await tx.get(extReference)
    if (!eSnap.exists()) throw new Error('Extinguisher no longer exists')

    before = eSnap.data()
    const updates = reportEffect(before, report)
    merged = { ...before, ...updates }

    tx.update(extReference, { ...updates, updatedAt: serverTimestamp() })
    // The public QR page, in the same write. A mirror that lands without its
    // extinguisher tells whoever scans the label the wrong thing about a unit
    // they are standing in front of.
    if (merged.qrToken) {
      tx.set(qrRef(merged.qrToken), mirrorPayload(orgName, report.extId, merged))
    }
    tx.update(reportReference, {
      approvalStatus: 'approved',
      reviewedBy: reviewerName || '',
      reviewedAt: serverTimestamp(),
    })
  })

  const reviewer = actor || { name: reviewerName }
  // Outside the transaction deliberately: bumpStats is a counter increment that
  // swallows its own failures, and a stats write that could abort the approval
  // would make the dashboard more important than the safety record.
  await bumpStats(statsDeltaFor(before, merged))
  const what = report.kind === 'defect' ? `defect (${report.defectType})` : `status → ${report.newStatus}`
  await logAudit(reviewer, AUDIT.REPORT_APPROVE, {
    target: 'report',
    targetId: report.extId,
    targetLabel: report.extLabel || report.extId,
    summary: `Approved ${what}`,
  })
}

/**
 * Release the lock on defects that are no longer live for a unit, so the same
 * fault can be reported again the next time it happens.
 *
 * Deleting a lock that is not there is not an error, and a failure here must
 * not fail the close it follows: the worst case is a stale lock that blocks one
 * re-report, which is far better than a refill that half-applied.
 */
export async function releaseDefectLocks(extId, defectTypes = []) {
  if (!extId || defectTypes.length === 0) return
  try {
    const batch = writeBatch(db)
    for (const key of defectTypes) batch.delete(defectLockRef(extId, key))
    await batch.commit()
  } catch { /* a stale lock is recoverable; a failed close is not */ }
}

export async function rejectReport(report, reviewerName, actor) {
  await updateDoc(reportRef(report.id), {
    approvalStatus: 'rejected',
    reviewedBy: reviewerName || '',
    reviewedAt: serverTimestamp(),
  })
  // Rejected means it was never a real defect, so it becomes reportable again.
  if (report.kind === 'defect' && report.defectType) {
    await releaseDefectLocks(report.extId, [report.defectType])
  }
  const what = report.kind === 'defect' ? `defect (${report.defectType})` : `status → ${report.newStatus}`
  await logAudit(actor || { name: reviewerName }, AUDIT.REPORT_REJECT, {
    target: 'report',
    targetId: report.extId,
    targetLabel: report.extLabel || report.extId,
    summary: `Rejected ${what}`,
  })
}

function queueClosures(batch, docs) {
  for (const data of docs) {
    batch.set(doc(closureCol()), { ...data, createdAt: serverTimestamp() })
  }
}

export function subscribeDefectClosures(cb) {
  const q = query(closureCol(), orderBy('closedOn', 'desc'), limit(COLLECTION_READ_CAP))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('defect closures', cb),
  )
}

// Evidence for a close. Same route as a quotation: cloud file when the bucket
// is there, inline under the Firestore ceiling when it is not. Not sealed —
// the picture is the repair, not a person.
async function evidencePhoto(file) {
  if (!file?.data) return null
  const name = file.name || 'evidence.jpg'
  const up = await putFile('defect-evidence', file.data, name)
  if (up) {
    return cleanClosurePhoto({
      url: up.url,
      path: up.path,
      contentType: up.contentType,
      name: up.name,
      size: up.size,
    })
  }
  const inlineBytes = Math.floor((String(file.data).split(',')[1] || '').length * 0.75)
  if (inlineBytes > MAX_INLINE_BYTES) throw new Error(tooLargeForInline(name))
  return cleanClosurePhoto({
    dataUrl: file.data,
    contentType: file.type || '',
    name,
    size: inlineBytes,
  })
}

// ── Workflow transitions (direct, used by portal action buttons) ───────────────
// Each stamps who performed the action (lastActionBy/lastAction/lastActionAt).

function actionStamp(actorName, label) {
  return { lastActionBy: actorName || '', lastAction: label, lastActionAt: serverTimestamp() }
}

/**
 * Submit a vendor quotation for the current defect/refill cycle. Must happen
 * before an item can progress (received-by-vendor / resolve). Stored on the
 * extinguisher doc; cleared when the cycle completes.
 */
export async function submitQuotation(orgName, id, { amount, vendor, ref, notes, fileName, fileType, fileData }, actorName) {
  // Resubmitting replaces the previous quotation; its cloud file would be
  // orphaned with nothing left remembering the path.
  const prev = await getExtinguisher(id)
  if (prev?.quotation?.filePath) removeFile(prev.quotation.filePath)

  // The document itself goes to cloud storage when available; the extinguisher
  // doc then carries a URL instead of the base64 payload.
  const up = fileData ? await putFile('quotations', fileData, fileName) : null
  // Base64 length * 3/4 is the decoded size, close enough to compare a limit.
  const inlineBytes = fileData ? Math.floor((String(fileData).split(',')[1] || '').length * 0.75) : 0
  if (!up && fileData && inlineBytes > MAX_INLINE_BYTES) {
    throw new Error(tooLargeForInline(fileName))
  }
  const quotation = {
    amount: Number(amount) || 0,
    vendor: vendor || '',
    ref: ref || '',
    notes: notes || '',
    fileName: fileName || '',
    fileType: fileType || '',
    fileData: up ? null : fileData || null, // legacy inline fallback (≤~700KB)
    fileUrl: up?.url || null,
    filePath: up?.path || null,
    submittedAt: todayISO(),
    submittedBy: actorName || '',
  }
  await updateExtinguisher(orgName, id, {
    quotation,
    ...actionStamp(actorName, 'Quotation submitted'),
  }, { actor: { name: actorName }, action: AUDIT.WF_QUOTATION_SUBMITTED, summary: `Quotation submitted (${quotation.amount}, ${quotation.vendor || 'vendor n/a'})` })
}

/**
 * Record a hydrostatic pressure test against a cylinder that was due one.
 *
 * The counterpart of submitQuotation, and deliberately not the same thing: a
 * quotation is a step towards buying work, an HPT IS the work, and it is the
 * event that clears the unit. So this writes the certificate and, on a pass,
 * moves dateOfNextHPT — which is what takes the unit off the To Be Refilled
 * list. On a FAILURE the date is left exactly where it is (see hptUpdate): a
 * failed test condemns the cylinder, and advancing the date would make a
 * condemned unit read as compliant for another cycle.
 */
export async function submitHpt(orgName, id, { testedOn, result, nextDueOn, vendor, ref, notes, fileName, fileType, fileData }, actorName) {
  // Re-recording replaces the previous certificate; its cloud file would be
  // orphaned with nothing left remembering the path.
  const prev = await getExtinguisher(id)
  if (prev?.hpt?.filePath) removeFile(prev.hpt.filePath)

  const up = fileData ? await putFile('hpt-certificates', fileData, fileName) : null
  const inlineBytes = fileData ? Math.floor((String(fileData).split(',')[1] || '').length * 0.75) : 0
  if (!up && fileData && inlineBytes > MAX_INLINE_BYTES) {
    throw new Error(tooLargeForInline(fileName))
  }

  const hpt = {
    testedOn: testedOn || '',
    result: result || '',
    nextDueOn: nextDueOn || '',
    vendor: vendor || '',
    ref: ref || '',
    notes: notes || '',
    fileName: fileName || '',
    fileType: fileType || '',
    fileData: up ? null : fileData || null,
    fileUrl: up?.url || null,
    filePath: up?.path || null,
    submittedAt: todayISO(),
    submittedBy: actorName || '',
  }

  const summary = hptSummary({ testedOn, result, vendor })
  // A pass is what takes the HPT-due row off the Defect Repository, because
  // the date moves. Record the close against the date it was due, so the
  // Closed filter still has the row. A failure leaves the date, and the defect.
  const hptClosure =
    result === 'pass' && prev && isHptOverdue(prev)
      ? [
          extinguisherClosureDoc(
            prev,
            'hpt_due',
            closureFields({
              remarks: summary,
              closedOn: testedOn,
              closedBy: actorName,
              source: CLOSURE_SOURCE.HPT,
            }),
            { forDate: prev.dateOfNextHPT || '' },
          ),
        ]
      : []
  await updateExtinguisher(orgName, id, {
    hpt,
    ...hptUpdate({ testedOn, result, nextDueOn }),
    ...actionStamp(actorName, summary),
  }, {
    actor: { name: actorName },
    action: AUDIT.WF_HPT_SUBMITTED,
    summary,
    withBatch: (batch) => queueClosures(batch, hptClosure),
  })
  return hpt
}

/** Vendor received the extinguisher for refilling. */
export async function markReceivedByVendor(orgName, id, actorName) {
  // The repository used to offer this beside Submit HPT. Refill Due does not,
  // and a cylinder that has not passed its test cannot be sent out for a
  // refill that would bring it back looking compliant.
  const before = await getExtinguisher(id)
  if (!before) throw new Error('Extinguisher not found')
  if (isHptOverdue(before)) throw new Error(HPT_BLOCKS_VENDOR)
  await updateExtinguisher(orgName, id, {
    status: STATUS.IN_PROCESS_REFILLING,
    ...actionStamp(actorName, 'Sent to vendor'),
  }, { actor: { name: actorName }, action: AUDIT.WF_SENT_TO_VENDOR, summary: 'Marked received by vendor (In Process)' })
}

/**
 * The unit is back from the vendor. Status returns to Active, the day it was
 * received is stored, and the next refill date moves with it. Empty and
 * over-pressure defects from this trip are closed in the same commit — they
 * are what the Defect Repository was showing, and a return that only flipped
 * the status would leave them open.
 */
export async function markReceivedFromVendor(orgName, id, { receivedOn, dateOfNextRefill }, actorName) {
  const before = await getExtinguisher(id)
  const result = receiveFromVendorUpdate(before, { receivedOn, dateOfNextRefill })
  if (result.error) throw new Error(result.error)
  const closures = receiveClosures(before, { receivedOn, closedBy: actorName })
  const closedLabels = closures.map((c) => c.defectLabel).join(', ')
  const summary = `Received back from vendor on ${receivedOn} (next refill ${dateOfNextRefill})${closedLabels ? `; closed ${closedLabels}` : ''}`
  await updateExtinguisher(orgName, id, {
    ...result.updates,
    ...actionStamp(actorName, 'Received'),
  }, {
    actor: { name: actorName },
    action: AUDIT.WF_RECEIVED,
    summary,
    withBatch: (batch) => queueClosures(batch, closures),
  })
  await releaseDefectLocks(id, result.clearedDefects)
  if (before?.quotation?.filePath) removeFile(before.quotation.filePath)
}

/** Extinguisher refilled & returned: close it, set new due dates, clear defects. */
export async function markRefilledAndClosed(
  orgName,
  id,
  { dateOfNextRefill, dateOfNextHPT, certificate },
  actorName,
) {
  const dateError = validateRefilledClosed({ dateOfNextRefill, dateOfNextHPT })
  if (dateError) throw new Error(dateError)
  const before = await getExtinguisher(id)
  const hptMoved = !hptDateUnchanged(before?.dateOfNextHPT, dateOfNextHPT)
  // A later hydrostatic date is a passed test. The register edit and the CSV
  // import may still correct a stored date — that is data entry. This button
  // is the one that records the date as the outcome of a refill, so the
  // certificate has to be in the same write.
  const certError = validateRefilledHpt(before?.dateOfNextHPT, { dateOfNextHPT, certificate })
  if (certError) throw new Error(certError)
  let hptFields = {}
  if (hptMoved) {
    if (before?.hpt?.filePath) removeFile(before.hpt.filePath)
    const fileData = certificate?.fileData || null
    const fileName = certificate?.fileName || ''
    const up = fileData ? await putFile('hpt-certificates', fileData, fileName) : null
    const inlineBytes = fileData ? Math.floor((String(fileData).split(',')[1] || '').length * 0.75) : 0
    if (!up && fileData && inlineBytes > MAX_INLINE_BYTES) throw new Error(tooLargeForInline(fileName))
    hptFields = {
      hpt: {
        testedOn: certificate?.testedOn || '',
        result: 'pass',
        nextDueOn: dateOfNextHPT,
        vendor: certificate?.vendor || '',
        ref: certificate?.ref || '',
        notes: certificate?.notes || '',
        fileName,
        fileType: certificate?.fileType || '',
        fileData: up ? null : fileData,
        fileUrl: up?.url || certificate?.fileUrl || null,
        filePath: up?.path || certificate?.filePath || null,
        submittedAt: todayISO(),
        submittedBy: actorName || '',
      },
    }
  }
  const closedOn = todayISO()
  const closure = closureFields({
    remarks: 'Refilled and returned to service',
    closedOn,
    closedBy: actorName,
    source: CLOSURE_SOURCE.REFILLED,
  })
  const closures = (before?.physicalDefects || []).map((defectType) =>
    extinguisherClosureDoc(before, defectType, closure),
  )
  if (before && isHptOverdue(before)) {
    closures.push(
      extinguisherClosureDoc(before, 'hpt_due', closure, { forDate: before.dateOfNextHPT || '' }),
    )
  }
  await updateExtinguisher(orgName, id, {
    status: STATUS.ACTIVE,
    dateOfNextRefill,
    dateOfNextHPT,
    physicalDefects: [],
    quotation: null,
    lastRefilledAt: closedOn,
    ...hptFields,
    ...actionStamp(actorName, 'Refilled & Closed'),
  }, {
    actor: { name: actorName },
    action: AUDIT.WF_REFILLED_CLOSED,
    summary: `Refilled & closed (next refill ${dateOfNextRefill}, next HPT ${dateOfNextHPT})`,
    withBatch: (batch) => queueClosures(batch, closures),
  })
  // A refill clears every defect, so every one of them becomes reportable again.
  await releaseDefectLocks(id, before?.physicalDefects || [])
  // The cleared quotation's cloud file goes with it.
  if (before?.quotation?.filePath) removeFile(before.quotation.filePath)
}

/** Resolve (clear) physical defects without a refill. */
export async function resolveDefects(orgName, id, remainingDefects = [], actorName) {
  const before = await getExtinguisher(id)
  if (!before) throw new Error('Extinguisher not found')
  const kept = new Set(remainingDefects)
  const removed = (before?.physicalDefects || []).filter((k) => !kept.has(k))
  // The open-defect log resolved in one click. The other lists already refuse
  // that until the test is recorded and a quotation is in. Checked here, on
  // the write, so a second screen cannot skip the step the first one shows.
  const removedPhysical = removed.filter((k) => PHYSICAL_DEFECT_KEYS.includes(k))
  if (removedPhysical.length) {
    const block = resolveBlockReason(before)
    if (block) throw new Error(block)
  }
  const closure = closureFields({
    remarks: 'Resolved on the unit',
    closedOn: todayISO(),
    closedBy: actorName,
    source: CLOSURE_SOURCE.RESOLVE,
  })
  const closures = removed.map((defectType) => extinguisherClosureDoc(before, defectType, closure))
  await updateExtinguisher(orgName, id, {
    physicalDefects: remainingDefects,
    quotation: null,
    ...actionStamp(actorName, 'Resolved defects'),
  }, {
    actor: { name: actorName },
    action: AUDIT.WF_RESOLVED_DEFECTS,
    summary: 'Physical defects resolved',
    withBatch: (batch) => queueClosures(batch, closures),
  })
  // Only the ones actually cleared — a defect left on the unit stays locked.
  await releaseDefectLocks(id, removed)
  if (before?.quotation?.filePath) removeFile(before.quotation.filePath)
}

/**
 * Close one open defect from the Defect Repository.
 *
 * `descriptor` names which row: an extinguisher defect (including HPT due and
 * Empty) or an AED / fire-alarm report. The closure document is what the
 * Closed filter and the export read. The unit or the report is updated in the
 * same commit so the open list loses the row.
 *
 * Manual closes are offered to managers in the UI, the same gate as Resolve
 * and Confirm. The write itself is a writer's write — Received, which any
 * writer can do, closes the refill defects through the same collection, and a
 * rule that reserved it for managers would refuse that return.
 */
export async function closeDefect(orgName, descriptor, input, actor) {
  const error = validateClosure(input)
  if (error) throw new Error(error)
  const photo = await evidencePhoto(input.file)
  const closure = closureFields({
    remarks: input.remarks,
    closedOn: input.closedOn,
    closedBy: actor?.name,
    closedByUid: actor?.uid,
    photo,
    source: CLOSURE_SOURCE.MANUAL,
  })
  const label = descriptor.defectLabel || descriptor.defectType || 'defect'
  const summary = `Closed ${label}: ${closure.remarks}`

  if (descriptor.kind === 'extinguisher') {
    const ext = await getExtinguisher(descriptor.extId)
    if (!ext) throw new Error('Extinguisher not found')
    // Clearing a physical defect while the test is overdue is the same
    // "this unit is fine" outcome Resolve refuses. An HPT-due row and an
    // Empty row do not remove those keys, so they stay closeable.
    if (PHYSICAL_DEFECT_KEYS.includes(descriptor.defectType) && isHptOverdue(ext)) {
      throw new Error(HPT_BLOCKS_RESOLVE)
    }
    const updates = {
      ...extinguisherCloseUpdate(ext, descriptor.defectType),
      ...actionStamp(actor?.name, 'Defect closed'),
    }
    const removed = descriptor.defectType !== 'hpt_due'
    if (removed && updates.physicalDefects.length === 0) updates.quotation = null
    const docFields = extinguisherClosureDoc(ext, descriptor.defectType, closure, {
      forDate: descriptor.defectType === 'hpt_due' ? ext.dateOfNextHPT || '' : '',
    })
    await updateExtinguisher(orgName, descriptor.extId, updates, {
      actor,
      action: AUDIT.DEFECT_CLOSE,
      summary,
      withBatch: (batch) => queueClosures(batch, [docFields]),
    })
    if (removed) {
      await releaseDefectLocks(descriptor.extId, [descriptor.defectType])
      if (updates.quotation === null && ext.quotation?.filePath) removeFile(ext.quotation.filePath)
    }
    return
  }

  if (!descriptor.reportId) throw new Error('That defect report no longer exists.')
  const batch = writeBatch(db)
  batch.update(reportRef(descriptor.reportId), {
    approvalStatus: 'closed',
    closure,
    reviewedBy: actor?.name || '',
    reviewedAt: serverTimestamp(),
  })
  queueClosures(batch, [assetClosureDoc(descriptor, closure)])
  await batch.commit()
  await logAudit(actor, AUDIT.DEFECT_CLOSE, {
    target: descriptor.assetKind || 'report',
    targetId: descriptor.assetRefId || descriptor.reportId,
    targetLabel: descriptor.assetLabel || descriptor.serialNo || label,
    summary,
  })
}

// ── Safety signage inventory (org-scoped, site-wise) ──────────────────────────
// A lightweight inventory of fire/safety signage per centerName (site). No QR
// mirror or stats — these are simple records read live and edited in place.

export function subscribeSignages(cb) {
  const q = query(signageCol(), orderBy('createdAt', 'desc'), limit(COLLECTION_READ_CAP))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    // Missing-field/order errors shouldn't crash the app before any data exists.
    (err) => { if (!isSessionEnd('signage', err)) console.warn('[Fire Marshal] signage subscribe failed:', err?.message || err) }
  )
}

// The photo pointer as stored on the signage document: where the bytes are
// (`path`, resolved through an authenticated fetch — see StoredImage) plus what
// the reader needs to rebuild them. Only these keys are kept, so a form object
// carrying anything else cannot smuggle it into the document. `dataUrl` exists
// only for the inline fallback used when Cloud Storage is unavailable.
const PHOTO_KEYS = ['url', 'path', 'dataUrl', 'contentType', 'name', 'size']
export const cleanSignagePhoto = (p) => {
  if (!p || typeof p !== 'object') return null
  const out = {}
  for (const k of PHOTO_KEYS) if (p[k] !== undefined && p[k] !== null && p[k] !== '') out[k] = p[k]
  return out.path || out.url || out.dataUrl ? out : null
}

const cleanSignage = (data) => ({
  centerName: (data.centerName || '').trim(),
  // The edit form has carried a SiteScopePicker all along, and this dropped the
  // siteId it produced — so picking a site on a signage looked like it worked
  // and stored nothing, leaving the record findable only by its typed name.
  siteId: data.siteId || '',
  siteName: data.siteName || data.site || '',
  region: data.region || '',
  entity: data.entity || '',
  type: data.type || 'Other',
  floor: (data.floor || '').trim(),
  location: (data.location || '').trim(),
  // (No `condition`: compliance now comes from `status`. Stored values on older
  // records are left as they are — updateDoc only touches the fields written.)
  // '' = never set (every record written before this field existed).
  status: SIGNAGE_STATUSES.includes(data.status) ? data.status : '',
  quantity: Number(data.quantity) || 1,
  lastChecked: data.lastChecked || '',
  notes: (data.notes || '').trim(),
  // FERP floor coverage (only meaningful for FERP Signage).
  totalFloors: Number(data.totalFloors) || 0,
  allFloors: !!data.allFloors,
  floorsCovered: Number(data.floorsCovered) || 0,
})

/**
 * Resolve the record's photos (`data.photos`, or the legacy single `data.photo`
 * read as one) into the pointers to store. Entries that are freshly picked
 * (compressed `data:` URLs) are uploaded; stored pointers are kept as they are.
 * → { photos, uploaded } where `uploaded` lists the storage paths created by THIS
 * call, so a failed write can remove them again.
 *
 * Same route as every other photo in the app: putFile → Cloud Storage under
 * `orgs/<orgId>/signage-photos/…` (covered by the generic tenant + type + size
 * rule in storage.rules). Not sealed: signage photos show a wall sign, not
 * people, so — like inspection, LOTO and quotation photos — they take no
 * `collection` and no sealing policy. When the bucket is unavailable putFile
 * returns null and the image is kept inline, under the 700 KB Firestore ceiling.
 */
async function resolveSignagePhotos(data) {
  const photos = []
  const uploaded = []
  try {
    for (const entry of signagePhotos(data)) {
      if (typeof entry !== 'string') {
        const kept = cleanSignagePhoto(entry)
        if (kept) photos.push(kept)
        continue
      }
      const up = await putFile('signage-photos', entry, 'signage.jpg')
      if (up) {
        uploaded.push(up.path)
        photos.push(cleanSignagePhoto({ url: up.url, path: up.path, contentType: up.contentType, name: up.name, size: up.size }))
        continue
      }
      const bytes = Math.floor(((entry.length - entry.indexOf(',') - 1) * 3) / 4)
      if (bytes > MAX_INLINE_BYTES) throw new Error(tooLargeForInline('Signage photo'))
      photos.push({ dataUrl: entry, contentType: 'image/jpeg', size: bytes })
    }
  } catch (e) {
    for (const path of uploaded) removeFile(path)
    throw e
  }
  return { photos, uploaded }
}

// Deployed needs evidence. The form shows this inline and disables Save; it is
// checked again here because the form is not the only thing that could call.
function assertDeployable(data, prev) {
  const errs = deployedRequirementErrors(data, prev)
  const first = Object.values(errs)[0]
  if (first) throw new Error(first)
}

export async function addSignage(data, actor) {
  assertDeployable(data, null)
  const { photos, uploaded } = await resolveSignagePhotos(data)
  let ref
  try {
    ref = await addDoc(signageCol(), {
      ...cleanSignage(data),
      photos,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  } catch (e) {
    for (const path of uploaded) removeFile(path)
    throw e
  }
  await logAudit(actor, 'signage.create', {
    target: 'signage',
    targetId: ref.id,
    targetLabel: `${data.type} @ ${data.centerName}`,
    summary: `${data.type}${data.status ? ` (${data.status})` : ''} @ ${data.centerName}`,
  })
  return ref.id
}

/**
 * @param prev the stored record being replaced — needed to know whether status
 *             is being SET to Deployed, and which photo files it leaves behind.
 *             Read from Firestore when the caller does not have it.
 */
export async function updateSignage(id, updates, actor, prev) {
  if (prev === undefined) {
    const snap = await getDoc(signageRef(id))
    prev = snap.exists() ? { id, ...snap.data() } : null
  }
  assertDeployable(updates, prev)
  const { photos, uploaded } = await resolveSignagePhotos(updates)
  try {
    // `photos` is the field now; the legacy single `photo` is migrated by being
    // dropped in the same write (its pointer is already inside `photos`).
    await updateDoc(signageRef(id), {
      ...cleanSignage(updates),
      photos,
      photo: deleteField(),
      updatedAt: serverTimestamp(),
    })
  } catch (e) {
    for (const path of uploaded) removeFile(path)
    throw e
  }
  // Files the record no longer points at go with it (replaced or removed).
  // After the write, so a failed save never leaves a record naming a deleted file.
  const keep = new Set(photos.map((p) => p.path).filter(Boolean))
  for (const old of signagePhotos(prev)) {
    if (old?.path && !keep.has(old.path)) removeFile(old.path)
  }
  await logAudit(actor, 'signage.update', {
    target: 'signage',
    targetId: id,
    targetLabel: `${updates.type} @ ${updates.centerName}`,
    summary: 'Signage updated',
  })
}

/** @param photoPaths storage path(s) of the record's photo file(s), removed with it */
export async function deleteSignage(id, actor, label, photoPaths) {
  await deleteDoc(signageRef(id))
  for (const path of [].concat(photoPaths || [])) if (path) removeFile(path)
  await logAudit(actor, 'signage.delete', { target: 'signage', targetId: id, targetLabel: label || '' })
}

// ── First aid box contents (org-scoped, site-wise) ────────────────────────────
// One document per (site, box, item): what the box is meant to hold, how much
// of it is actually there, and when it goes out of date. Like signage and
// unlike an AED these are inventory records rather than scannable assets — no
// QR mirror and no stats counter, read live and edited in place.

export function subscribeFirstAid(cb) {
  const q = query(firstAidCol(), orderBy('createdAt', 'desc'), limit(COLLECTION_READ_CAP))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => { if (!isSessionEnd('first aid', err)) console.warn('[Fire Marshal] first aid subscribe failed:', err?.message || err) }
  )
}

const cleanFirstAid = (data) => ({
  centerName: (data.centerName || '').trim(),
  // The resolved site-registry link. Signage dropped this field for months and
  // its site picker looked like it worked while storing nothing; the same
  // picker is on this form, so the same field has to be written here.
  siteId: data.siteId || '',
  siteName: data.siteName || data.site || '',
  region: data.region || '',
  entity: data.entity || '',
  item: data.item || '',
  // Which box at the site this row counts. Free text, because a site's boxes
  // are known by where they are ("Reception", "Gym floor") rather than by any
  // number printed on them.
  boxLocation: (data.boxLocation || '').trim(),
  // Zero is a real answer here — "we opened the box and there were none" — so
  // this defaults to 0 rather than signage's 1. A blank that silently became
  // one would turn an empty shelf into stock.
  quantity: Number(data.quantity) || 0,
  condition: data.condition || 'Available',
  expiryDate: data.expiryDate || '',
  lastChecked: data.lastChecked || '',
  notes: (data.notes || '').trim(),
})

export async function addFirstAid(data, actor) {
  const ref = await addDoc(firstAidCol(), {
    ...cleanFirstAid(data),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  await logAudit(actor, 'firstaid.create', {
    target: 'firstaid',
    targetId: ref.id,
    targetLabel: `${data.item} @ ${data.centerName}`,
    summary: `${data.item} × ${data.quantity ?? 0} (${data.condition}) @ ${data.centerName}`,
  })
  return ref.id
}

export async function updateFirstAid(id, updates, actor) {
  await updateDoc(firstAidRef(id), { ...cleanFirstAid(updates), updatedAt: serverTimestamp() })
  await logAudit(actor, 'firstaid.update', {
    target: 'firstaid',
    targetId: id,
    targetLabel: `${updates.item} @ ${updates.centerName}`,
    summary: 'First aid item updated',
  })
}

export async function deleteFirstAid(id, actor, label) {
  await deleteDoc(firstAidRef(id))
  await logAudit(actor, 'firstaid.delete', { target: 'firstaid', targetId: id, targetLabel: label || '' })
}

/**
 * Write one whole box in a single pass.
 *
 * The contents checklist is sixteen rows on one screen, and saving it a row at
 * a time would be sixteen writes, sixteen audit entries and a half-saved box if
 * the fifth of them failed. `rows` are creates (no id) and updates (with one);
 * `removals` are the ids of items the checker unticked.
 */
export async function saveFirstAidBox(rows, removals, actor, label) {
  const writes = [
    ...rows.map((row) => ({ kind: row.id ? 'update' : 'create', row })),
    ...removals.map((id) => ({ kind: 'delete', id })),
  ]
  for (let i = 0; i < writes.length; i += BULK_CHUNK) {
    const batch = writeBatch(db)
    for (const w of writes.slice(i, i + BULK_CHUNK)) {
      if (w.kind === 'delete') { batch.delete(firstAidRef(w.id)); continue }
      const data = cleanFirstAid(w.row)
      if (w.kind === 'update') batch.update(firstAidRef(w.row.id), { ...data, updatedAt: serverTimestamp() })
      else batch.set(doc(firstAidCol()), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
    }
    await batch.commit()
  }
  await logAudit(actor, 'firstaid.update', {
    target: 'firstaid',
    targetLabel: label || '',
    summary: `First aid box checked — ${rows.length} item(s) recorded${removals.length ? `, ${removals.length} removed` : ''}`,
  })
  return { written: rows.length, removed: removals.length }
}

// ── Mock drills / emergency response records (org-scoped, site-wise) ───────────

export function subscribeMockDrills(cb) {
  const q = query(drillCol(), orderBy('createdAt', 'desc'), limit(COLLECTION_READ_CAP))
  const opened = openSnapshots(SEALED_DRILLS, cb)
  return onSnapshot(
    q,
    (snap) => opened(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => { if (!isSessionEnd('mock drills', err)) console.warn('[Fire Marshal] mock drill subscribe failed:', err?.message || err) }
  )
}

/**
 * Save a mock-drill / emergency record. `data` is the full sanitized form object;
 * `data.photos` (array of base64 data URLs) is split off into a subcollection so
 * the main doc — and the live list — stay small.
 */
export async function addMockDrill(data, actor) {
  const { photos = [], ...rest } = data
  const valid = (Array.isArray(photos) ? photos : []).filter((p) => typeof p === 'string' && p.startsWith('data:'))

  // ── The evidence goes first, and the count is what actually landed ──────────
  //
  // The drill document used to be written with `photoCount: valid.length`
  // BEFORE the upload loop — two sequential awaits per photo, any of which can
  // throw. A failure part-way left a drill claiming more evidence than was
  // stored, and MockDrills gates the fetch on `photoCount > 0`, so the viewer
  // sat waiting for photographs that would never arrive. Meanwhile the caller
  // was told the save had failed, for a drill that was saved.
  //
  // Reversed, so the count cannot be a promise the record fails to keep. The
  // photos are written into the subcollection of an id reserved up front —
  // Firestore does not require the parent to exist first — and the drill
  // document is written LAST, from the number that survived.
  const ref = doc(drillCol())

  // Parallel, and each photo owns its own failure. Sequentially, one unreadable
  // capture ended the loop and abandoned every photo behind it; the person who
  // ran the drill loses the rest of their evidence to the one that failed.
  const stored = await Promise.all(valid.map(async (dataUrl) => {
    try {
      const up = await putFile('drill-evidence', dataUrl, 'evidence.jpg', { collection: SEALED_DRILL_PHOTOS })
      // The pointer AND the bytes are sealed — policy.js sets `files: true` for
      // mockDrills/photos, and putFile honours it. This comment used to say the
      // bucket object was left in the clear because sealing it would hand an
      // <img> a URL pointing at ciphertext; that stopped being true when the
      // decryption moved into shared/storage/resolveFiles.js, which is the seam
      // getMockDrillPhotos reads through.
      await addDoc(drillPhotoCol(ref.id), up
        ? {
          url: up.url,
          path: up.path,
          createdAt: serverTimestamp(),
          ...(up.encIv ? { encScheme: up.encScheme, encKeyId: up.encKeyId, encIv: up.encIv, ...(up.encWrapped ? { encWrapped: up.encWrapped } : {}) } : {}),
        }
        : await sealDoc(SEALED_DRILL_PHOTOS, { dataUrl, createdAt: serverTimestamp() }))
      return true
    } catch (e) {
      reportError(e, { source: 'fire.addMockDrill.photo' })
      return false
    }
  }))
  const savedPhotos = stored.filter(Boolean).length

  // Strip undefined values — Firestore rejects them.
  const payload = JSON.parse(JSON.stringify({
    ...rest,
    photoCount: savedPhotos,
    loggedBy: actor?.name || '',
    createdAt: null, // placeholder; replaced by serverTimestamp below
  }))
  payload.createdAt = serverTimestamp()
  payload.docId = await reserveDocId('drills')
  // Photos are still the data URLs the recorder holds. The stored document
  // does not keep them — they go to the subcollection above — but the print
  // embeds them, and this is the moment the mail's copy is made.
  const reportPdfPath = await mailedDrillPdf({ ...payload, photos: valid })
  if (reportPdfPath) payload.reportPdfPath = reportPdfPath
  // The person saving the drill is the assigner of every CAPA row on it.
  // Drill reports are written once; there is no later edit that would need
  // the "only when the assignee changed" diff incidents use. The uid is what
  // the assignment mail uses to skip a commander assigning themselves.
  if (Array.isArray(payload.capa) && actor?.uid) {
    payload.capa = payload.capa.map((row) =>
      row && typeof row === 'object' ? { ...row, assignedByUid: actor.uid } : row,
    )
  }
  // Sealed AFTER the JSON round-trip above, not before: that round-trip exists
  // to strip undefined values, and JSON.parse(JSON.stringify(...)) on sealed
  // data would be harmless but the ORDER matters the other way round — a
  // payload sealed first and then passed through JSON would still be sealed,
  // while an unsealed `undefined` reaching Firestore is a rejected write.
  await setDoc(ref, await sealDoc(SEALED_DRILLS, payload))
  await logAudit(actor, 'mockdrill.create', {
    module: 'drills',
    target: 'mockdrill',
    targetId: ref.id,
    targetLabel: `${data.scenario} @ ${data.centerName || '—'}`,
    summary: `${data.eventType}: ${data.scenario} (score ${data.score}%) @ ${data.centerName || '—'}`,
  })
  // The shortfall is RETURNED, not swallowed. A drill saved with four of five
  // photographs is a success the person recording it still needs to know about,
  // while they are still standing where they took them.
  return { id: ref.id, photosRequested: valid.length, photosSaved: savedPhotos }
}

/**
 * Fetch a mock drill's evidence photos on demand. Returns [{ id, dataUrl }] —
 * the seam normalises cloud photos onto the same field, so every renderer and
 * the PDF keep reading `.dataUrl` whichever era the photo was saved in.
 */
export async function getMockDrillPhotos(drillId) {
  const snap = await getDocs(drillPhotoCol(drillId))
  // Opened BEFORE the `.dataUrl || .url` normalisation: an inline photo's
  // dataUrl is sealed, and the fallback run first would see an envelope, find
  // it truthy, and hand every renderer a base64 string in place of an image.
  const rows = await openDocs(SEALED_DRILL_PHOTOS, snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  const normalised = rows.map((r) => ({ ...r, id: r.id, path: r.path || '', dataUrl: r.dataUrl || r.url || '' }))
  // A sealed object becomes a blob: URL, which pins its bytes until revoked.
  // Unlike the subscriptions, this is a one-shot read with no unsubscribe to
  // hang the cleanup on — so the revoke comes back with the rows and the caller
  // holds it. `revoke` is a no-op when nothing was encrypted, which is every
  // drill recorded before sealing was switched on.
  const { rows: resolved, revoke } = await resolveSealedFiles(SEALED_DRILL_PHOTOS, normalised)
  resolved.revoke = revoke
  return resolved
}

async function mailedDrillPdf(record) {
  if (typeof document === 'undefined') return ''
  try {
    const { captureDrillReport } = await import('./drillReportPdf.js')
    return await captureDrillReport(record)
  } catch (e) {
    reportError(e, { source: 'fire.mailedDrillPdf' })
    return ''
  }
}

export async function deleteMockDrill(id, actor, label) {
  try {
    const parent = await getDoc(drillRef(id))
    discardMailedReport(parent.data()?.reportPdfPath)
  } catch (e) {
    reportError(e, { source: 'fire.deleteMockDrill.pdf' })
  }
  // Remove evidence photos first (non-fatal if it fails). Cloud copies go too —
  // a photo doc is the only thing that remembers its storage path.
  try {
    const snap = await getDocs(drillPhotoCol(id))
    for (const d of snap.docs) {
      if (d.data().path) removeFile(d.data().path)
    }
    // One write each, so chunk well inside the 500-op batch limit. A drill with
    // a hundred evidence photos used to fire a hundred separate deletes.
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = writeBatch(db)
      for (const d of snap.docs.slice(i, i + 400)) batch.delete(d.ref)
      await batch.commit()
    }
  } catch (e) {
    console.warn('[Fire Marshal] drill photo cleanup skipped:', e?.message || e)
  }
  await deleteDoc(drillRef(id))
  await logAudit(actor, 'mockdrill.delete', { module: 'drills', target: 'mockdrill', targetId: id, targetLabel: label || '' })
}

// ── AED (Automated External Defibrillator) inventory (org-scoped) ──────────────
export function subscribeAeds(cb) {
  const q = query(aedCol(), orderBy('createdAt', 'desc'), limit(COLLECTION_READ_CAP))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => { if (!isSessionEnd('AEDs', err)) console.warn('[Fire Marshal] AED subscribe failed:', err?.message || err) }
  )
}

const cleanAed = (d) => ({
  assetId: (d.assetId || '').trim(),
  brand: (d.brand || '').trim(),
  model: (d.model || '').trim(),
  centerName: (d.centerName || '').trim(),
  // Set when the site was resolved against the registry (bulk upload, linking
  // pass). Without it here the id would be silently dropped on write.
  siteId: d.siteId || '',
  region: d.region || '',
  entity: d.entity || '',
  location: (d.location || '').trim(),
  status: d.status || 'ready',
  installDate: d.installDate || '',
  batteryExpiry: d.batteryExpiry || '',
  padExpiry: d.padExpiry || '',
  lastInspection: d.lastInspection || '',
  nextInspection: d.nextInspection || '',
  notes: (d.notes || '').trim(),
})

// Public-readable QR mirror for an AED (keyed by qrToken, under /qr/{token}).
function aedMirror(orgName, id, a) {
  return {
    assetKind: 'aed', orgName: orgName || '', assetRefId: id, token: a.qrToken,
    label: a.assetId || 'AED', brand: a.brand || '', model: a.model || '',
    centerName: a.centerName || '', region: a.region || '', entity: a.entity || '', location: a.location || '',
    status: a.status || 'ready', batteryExpiry: a.batteryExpiry || '', padExpiry: a.padExpiry || '',
    lastInspection: a.lastInspection || '', nextInspection: a.nextInspection || '',
    deletedAt: a.deletedAt || null,
    updatedAt: serverTimestamp(),
  }
}

/**
 * Attach AEDs or FAS devices to the site registry and adopt its wording.
 *
 * Unlike the extinguisher pass, this rewrites centerName to the matched site's
 * name. Both kinds are listed, filtered and searched by that string, so leaving
 * the source system's version in place means the same building reads as two
 * different places depending on which module you are looking at.
 *
 * The original is preserved once, as sourceCenterName. If a match is ever
 * wrong, that string is the only evidence of what the asset actually arrived
 * with — and it is what the override table is keyed on, so without it a bad
 * link could not be traced back.
 *
 * `plan` comes from planSiteLinks(); nothing here decides what matches.
 */
async function linkKindToSites(orgName, plan, actor, kind) {
  const items = plan.linked
  if (!items.length) return { linked: 0, entityChanges: 0, nameChanges: 0 }

  // Two writes per asset, so chunk well inside the 500-op batch limit.
  for (let i = 0; i < items.length; i += 200) {
    const batch = writeBatch(db)
    for (const { asset, site } of items.slice(i, i + 200)) {
      // Same coercion as the extinguisher pass: a registry row is not obliged
      // to carry a name or an entity, and Firestore rejects undefined outright,
      // so one blank field failed the whole batch rather than that one asset.
      const siteName = site.name || ''
      const update = {
        siteId: site.id,
        siteName,
        centerName: siteName,
        entity: site.entity || '',
        updatedAt: serverTimestamp(),
      }
      if (!asset.sourceCenterName && asset.centerName) update.sourceCenterName = asset.centerName
      batch.update(kind.ref(asset.id), update)
      // Signage has no public QR page, so a kind may have no mirror at all.
      // The scanned label shows centerName and entity, so the public mirror has
      // to move in the same batch or a QR would keep showing the old site.
      if (asset.qrToken && kind.mirror) batch.set(qrRef(asset.qrToken), kind.mirror(orgName, asset.id, { ...asset, ...update }))
    }
    await batch.commit()
  }

  await logAudit(actor, `${kind.name}.update`, {
    target: kind.name,
    summary: `Linked ${items.length} ${kind.label}(s) to sites; ${plan.nameChanges} renamed and ${plan.entityChanges} entity value(s) corrected from the site registry`,
  })
  return { linked: items.length, entityChanges: plan.entityChanges, nameChanges: plan.nameChanges }
}

export const linkAedsToSites = (orgName, plan, actor) =>
  linkKindToSites(orgName, plan, actor, { name: 'aed', label: 'AED', ref: aedRef, mirror: aedMirror })

export const linkFasToSites = (orgName, plan, actor) =>
  linkKindToSites(orgName, plan, actor, { name: 'fas', label: 'FAS device', ref: fasRef, mirror: fasMirror })

// No mirror: signage is an inventory record, not a scannable asset.
export const linkSignagesToSites = (orgName, plan, actor) =>
  linkKindToSites(orgName, plan, actor, { name: 'signage', label: 'signage', ref: signageRef })

export const linkStretchersToSites = (orgName, plan, actor) =>
  linkKindToSites(orgName, plan, actor, { name: 'stretcher', label: 'stretcher', ref: stretcherRef, mirror: stretcherMirror })

// No mirror, for the same reason as signage: a first aid row counts what is in
// a box, and nothing scans it.
export const linkFirstAidToSites = (orgName, plan, actor) =>
  linkKindToSites(orgName, plan, actor, { name: 'firstaid', label: 'first aid record', ref: firstAidRef })

/**
 * Link every register in one action, from the plans planAllSiteLinks produced.
 *
 * Each kind still writes through its own function, because the writes differ —
 * this only saves the reader running the same errand in three places. A kind
 * with nothing to do is skipped rather than called with an empty plan, so its
 * audit entry is not written either.
 *
 * Failures are per kind and reported, not swallowed: linking the AEDs is a real
 * outcome worth keeping even if the fire-alarm pass then fails, and a caller
 * that saw one error for the whole action could not tell you which of the three
 * actually landed.
 */
export async function linkAllEquipmentToSites(orgName, byKind, actor) {
  const runners = [
    ['ext', linkExtinguishersToSites],
    ['aed', linkAedsToSites],
    ['fas', linkFasToSites],
    ['sign', linkSignagesToSites],
    ['stretcher', linkStretchersToSites],
    ['firstAid', linkFirstAidToSites],
  ]
  const totals = { linked: 0, entityChanges: 0, nameChanges: 0 }
  const failed = []
  for (const [key, run] of runners) {
    const plan = byKind?.[key]
    if (!plan?.linked?.length) continue
    try {
      const r = await run(orgName, plan, actor)
      totals.linked += r.linked || 0
      totals.entityChanges += r.entityChanges || 0
      totals.nameChanges += r.nameChanges || 0
    } catch (e) {
      failed.push({ kind: key, message: e?.message || String(e) })
    }
  }
  return { ...totals, failed }
}

export async function addAed(orgName, data, actor) {
  // Records are created WITHOUT a QR — generating one is an admin-only action.
  const ref = doc(aedCol())
  const a = { ...cleanAed(data), createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
  const batch = writeBatch(db)
  batch.set(ref, a)
  await batch.commit()
  await logAudit(actor, 'aed.create', { target: 'aed', targetId: ref.id, targetLabel: `${data.assetId || 'AED'} @ ${data.centerName}`, summary: `AED ${data.assetId || ''} added @ ${data.centerName}` })
  return { id: ref.id }
}

export async function updateAed(orgName, id, updates, actor) {
  // Never mints a QR here — only keeps an existing mirror in sync (see generateAedQr).
  const a = { ...cleanAed(updates), updatedAt: serverTimestamp() }
  const batch = writeBatch(db)
  batch.update(aedRef(id), a)
  if (updates.qrToken) batch.set(qrRef(updates.qrToken), aedMirror(orgName, id, { ...updates, ...a, qrToken: updates.qrToken }))
  await batch.commit()
  await logAudit(actor, 'aed.update', { target: 'aed', targetId: id, targetLabel: `${updates.assetId || 'AED'} @ ${updates.centerName}`, summary: 'AED updated' })
  return updates.qrToken || null
}

/** Admin-only: mint (or re-use) a QR token for an AED and write its public mirror. */
export async function generateAedQr(orgName, asset, actor) {
  const qrToken = asset.qrToken || generateQrToken()
  const batch = writeBatch(db)
  batch.update(aedRef(asset.id), { qrToken, updatedAt: serverTimestamp() })
  batch.set(qrRef(qrToken), aedMirror(orgName, asset.id, { ...asset, qrToken }))
  await batch.commit()
  await logAudit(actor, 'aed.qr_generate', { target: 'aed', targetId: asset.id, targetLabel: `${asset.assetId || 'AED'} @ ${asset.centerName}`, summary: 'QR code generated' })
  return qrToken
}

/** Log a service/inspection: stamps last inspection today, sets the next due, marks Ready. */
export async function serviceAed(orgName, asset, nextInspection, actor) {
  const today = todayISO()
  const merged = { ...asset, lastInspection: today, nextInspection: nextInspection || '', status: 'ready' }
  const a = { ...cleanAed(merged), updatedAt: serverTimestamp() }
  const batch = writeBatch(db)
  batch.update(aedRef(asset.id), a)
  if (asset.qrToken) batch.set(qrRef(asset.qrToken), aedMirror(orgName, asset.id, { ...merged, qrToken: asset.qrToken }))
  await batch.commit()
  await logAudit(actor, 'aed.service', { target: 'aed', targetId: asset.id, targetLabel: `${asset.assetId || 'AED'} @ ${asset.centerName}`, summary: `AED serviced — next inspection ${nextInspection || '—'}` })
}

export async function deleteAed(id, qrToken, actor, label) {
  await retireAssets([{ id, qrToken }], aedRef, actor)
  await logAudit(actor, 'aed.delete', {
    target: 'aed', targetId: id, targetLabel: label || '',
    summary: `${label || 'AED'} moved to Recently deleted`,
  })
}

/** Soft-delete AEDs by [{id, qrToken}]. The QR mirror stays until purge. */
export async function bulkDeleteAeds(items, actor) {
  await retireAssets(items, aedRef, actor)
  await logAudit(actor, 'aed.bulk_delete', {
    target: 'aed', summary: `${items.length} AED(s) moved to Recently deleted`,
  })
}

const aedLabelOf = (a) => `${a?.assetId || 'AED'} @ ${a?.centerName || ''}`

export async function restoreAeds(orgName, ids, actor) {
  return reviveAssets(orgName, 'aed', ids, actor, {
    refOf: aedRef, colOf: aedCol, mirror: aedMirror, audit: 'aed.restore', labelOf: aedLabelOf,
  })
}

export async function restoreAed(orgName, id, actor) {
  return restoreAeds(orgName, [id], actor)
}

export async function purgeAed(id, qrToken, actor, label) {
  const batch = writeBatch(db)
  batch.delete(aedRef(id))
  if (qrToken) batch.delete(qrRef(qrToken))
  await batch.commit()
  await logAudit(actor, 'aed.purge', { target: 'aed', targetId: id, targetLabel: label || '' })
}

// ── Stretchers (org-scoped) ───────────────────────────────────────────────────
// Deliberately the AED's shape rather than signage's: a stretcher is one
// physical unit in one place, and the question asked of it — is THIS stretcher
// usable — is answered by a person standing in front of it. Hence the QR, the
// public defect sheet and the inspection cycle, none of which a signage-style
// site × type matrix could carry.
export function subscribeStretchers(cb) {
  const q = query(stretcherCol(), orderBy('createdAt', 'desc'), limit(COLLECTION_READ_CAP))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => { if (!isSessionEnd('stretchers', err)) console.warn('[Fire Marshal] stretcher subscribe failed:', err?.message || err) }
  )
}

const cleanStretcher = (d) => ({
  assetId: (d.assetId || '').trim(),
  type: d.type || 'Foldable',
  brand: (d.brand || '').trim(),
  model: (d.model || '').trim(),
  centerName: (d.centerName || '').trim(),
  // As with AEDs — the resolved registry link, dropped on write without this.
  siteId: d.siteId || '',
  region: d.region || '',
  entity: d.entity || '',
  location: (d.location || '').trim(),
  status: d.status || 'ready',
  installDate: d.installDate || '',
  lastInspection: d.lastInspection || '',
  nextInspection: d.nextInspection || '',
  notes: (d.notes || '').trim(),
})

// Public-readable QR mirror for a stretcher (keyed by qrToken, under /qr/{token}).
function stretcherMirror(orgName, id, a) {
  return {
    assetKind: 'stretcher', orgName: orgName || '', assetRefId: id, token: a.qrToken,
    label: a.assetId || 'Stretcher', stretcherType: a.type || '', brand: a.brand || '', model: a.model || '',
    centerName: a.centerName || '', region: a.region || '', entity: a.entity || '', location: a.location || '',
    status: a.status || 'ready',
    lastInspection: a.lastInspection || '', nextInspection: a.nextInspection || '', updatedAt: serverTimestamp(),
  }
}

export async function addStretcher(orgName, data, actor) {
  // Records are created WITHOUT a QR — generating one is an admin-only action.
  const ref = doc(stretcherCol())
  const a = { ...cleanStretcher(data), createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
  const batch = writeBatch(db)
  batch.set(ref, a)
  await batch.commit()
  await logAudit(actor, 'stretcher.create', { target: 'stretcher', targetId: ref.id, targetLabel: `${data.assetId || 'Stretcher'} @ ${data.centerName}`, summary: `Stretcher ${data.assetId || ''} added @ ${data.centerName}` })
  return { id: ref.id }
}

export async function updateStretcher(orgName, id, updates, actor) {
  // Never mints a QR here — only keeps an existing mirror in sync (see generateStretcherQr).
  const a = { ...cleanStretcher(updates), updatedAt: serverTimestamp() }
  const batch = writeBatch(db)
  batch.update(stretcherRef(id), a)
  if (updates.qrToken) batch.set(qrRef(updates.qrToken), stretcherMirror(orgName, id, { ...updates, ...a, qrToken: updates.qrToken }))
  await batch.commit()
  await logAudit(actor, 'stretcher.update', { target: 'stretcher', targetId: id, targetLabel: `${updates.assetId || 'Stretcher'} @ ${updates.centerName}`, summary: 'Stretcher updated' })
  return updates.qrToken || null
}

/** Admin-only: mint (or re-use) a QR token for a stretcher and write its public mirror. */
export async function generateStretcherQr(orgName, asset, actor) {
  const qrToken = asset.qrToken || generateQrToken()
  const batch = writeBatch(db)
  batch.update(stretcherRef(asset.id), { qrToken, updatedAt: serverTimestamp() })
  batch.set(qrRef(qrToken), stretcherMirror(orgName, asset.id, { ...asset, qrToken }))
  await batch.commit()
  await logAudit(actor, 'stretcher.qr_generate', { target: 'stretcher', targetId: asset.id, targetLabel: `${asset.assetId || 'Stretcher'} @ ${asset.centerName}`, summary: 'QR code generated' })
  return qrToken
}

/** Log an inspection: stamps last inspection today, sets the next due, marks Ready. */
export async function serviceStretcher(orgName, asset, nextInspection, actor) {
  const today = todayISO()
  const merged = { ...asset, lastInspection: today, nextInspection: nextInspection || '', status: 'ready' }
  const a = { ...cleanStretcher(merged), updatedAt: serverTimestamp() }
  const batch = writeBatch(db)
  batch.update(stretcherRef(asset.id), a)
  if (asset.qrToken) batch.set(qrRef(asset.qrToken), stretcherMirror(orgName, asset.id, { ...merged, qrToken: asset.qrToken }))
  await batch.commit()
  await logAudit(actor, 'stretcher.service', { target: 'stretcher', targetId: asset.id, targetLabel: `${asset.assetId || 'Stretcher'} @ ${asset.centerName}`, summary: `Stretcher inspected — next inspection ${nextInspection || '—'}` })
}

export async function deleteStretcher(id, qrToken, actor, label) {
  const batch = writeBatch(db)
  batch.delete(stretcherRef(id))
  if (qrToken) batch.delete(qrRef(qrToken))
  await batch.commit()
  await logAudit(actor, 'stretcher.delete', { target: 'stretcher', targetId: id, targetLabel: label || '' })
}

/** Bulk-delete stretchers (+ remove their QR mirrors) by [{id, qrToken}]. */
export async function bulkDeleteStretchers(items, actor) {
  for (let i = 0; i < items.length; i += BULK_CHUNK) {
    const batch = writeBatch(db)
    for (const { id, qrToken } of items.slice(i, i + BULK_CHUNK)) {
      batch.delete(stretcherRef(id))
      if (qrToken) batch.delete(qrRef(qrToken))
    }
    await batch.commit()
  }
  await logAudit(actor, 'stretcher.bulk_delete', { target: 'stretcher', summary: `${items.length} stretcher(s) deleted` })
}

export async function bulkAddStretchers(orgName, rows, actor) {
  let created = 0
  for (let i = 0; i < rows.length; i += BULK_CHUNK) {
    const batch = writeBatch(db)
    for (const row of rows.slice(i, i + BULK_CHUNK)) {
      const ref = doc(stretcherCol())
      const qrToken = generateQrToken()
      const a = { ...cleanStretcher(row), qrToken, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
      batch.set(ref, a)
      batch.set(qrRef(qrToken), stretcherMirror(orgName, ref.id, a))
      created++
    }
    await batch.commit()
  }
  await logAudit(actor, 'stretcher.bulk_create', { target: 'stretcher', summary: `Bulk added ${created} stretcher(s)` })
  return { created }
}

// ── FAS (Fire Alarm System) device inventory (org-scoped) ─────────────────────
export function subscribeFas(cb) {
  const q = query(fasCol(), orderBy('createdAt', 'desc'), limit(COLLECTION_READ_CAP))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => { if (!isSessionEnd('fire alarm devices', err)) console.warn('[Fire Marshal] FAS subscribe failed:', err?.message || err) }
  )
}

const cleanFas = (d) => ({
  deviceId: (d.deviceId || '').trim(),
  deviceType: d.deviceType || 'Other',
  zone: (d.zone || '').trim(),
  centerName: (d.centerName || '').trim(),
  // As with AEDs — the resolved registry link, dropped on write without this.
  siteId: d.siteId || '',
  region: d.region || '',
  entity: d.entity || '',
  location: (d.location || '').trim(),
  status: d.status || 'operational',
  installDate: d.installDate || '',
  lastService: d.lastService || '',
  nextService: d.nextService || '',
  amcVendor: (d.amcVendor || '').trim(),
  notes: (d.notes || '').trim(),
})

function fasMirror(orgName, id, a) {
  return {
    assetKind: 'fas', orgName: orgName || '', assetRefId: id, token: a.qrToken,
    label: a.deviceId || a.deviceType || 'FAS', deviceType: a.deviceType || '', zone: a.zone || '',
    centerName: a.centerName || '', region: a.region || '', entity: a.entity || '', location: a.location || '',
    status: a.status || 'operational', lastService: a.lastService || '', nextService: a.nextService || '',
    amcVendor: a.amcVendor || '',
    deletedAt: a.deletedAt || null,
    updatedAt: serverTimestamp(),
  }
}

export async function addFas(orgName, data, actor) {
  // A control panel is created WITH its QR. The single-add form used to store
  // the panel and leave the code for an admin to mint later, so a panel added
  // here had nothing for "Export QR codes" to print and a scan had no page.
  // Detectors still get none: the panel's code covers the system. A token
  // already on the row is kept.
  const ref = doc(fasCol())
  const clean = cleanFas(data)
  const qrToken = fasQrTokenForCreate(
    { ...clean, qrToken: data.qrToken, qrLink: data.qrLink },
    generateQrToken,
  )
  const a = {
    ...clean,
    ...(qrToken ? { qrToken } : {}),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  const batch = writeBatch(db)
  batch.set(ref, a)
  if (qrToken) batch.set(qrRef(qrToken), fasMirror(orgName, ref.id, a))
  await batch.commit()
  await logAudit(actor, 'fas.create', { target: 'fas', targetId: ref.id, targetLabel: `${data.deviceId || data.deviceType} @ ${data.centerName}`, summary: `FAS ${data.deviceType} added @ ${data.centerName}` })
  return { id: ref.id, qrToken: qrToken || null }
}

export async function updateFas(orgName, id, updates, actor) {
  // An edit never replaces a QR code. It mints one only when this save turns
  // the row into a control panel that still has none — changing a detector
  // into a panel is a create path the add form is not the only door to.
  //
  // The token is read inside the transaction, not taken from the form. The
  // form holds whatever the screen loaded; a panel edited from a stale row
  // would mint a second code and orphan the sticker already on the wall. The
  // backfill learned this the same way. Rules refuse the replacement too —
  // this is what lets the rest of the edit succeed while keeping the code.
  const clean = cleanFas(updates)
  let qrToken = ''
  let minted = false
  await runTransaction(db, async (tx) => {
    const ref = fasRef(id)
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('Fire-alarm device not found')
    const stored = snap.data() || {}
    const decided = fasQrTokenForUpdate(stored.qrToken, clean, generateQrToken)
    qrToken = decided.qrToken
    minted = decided.minted
    const a = { ...clean, ...(qrToken ? { qrToken } : {}), updatedAt: serverTimestamp() }
    tx.update(ref, a)
    if (qrToken) {
      tx.set(qrRef(qrToken), fasMirror(orgName, id, { ...stored, ...clean, qrToken }))
    }
  })
  await logAudit(actor, 'fas.update', { target: 'fas', targetId: id, targetLabel: `${updates.deviceId || updates.deviceType} @ ${updates.centerName}`, summary: minted ? 'FAS device updated — QR code generated' : 'FAS device updated' })
  return qrToken || null
}

/** Mint a QR token for one FAS control panel, or reuse the token it already has. */
export async function generateFasQr(orgName, asset, actor) {
  // Reuse first, and re-read first. The asset on screen can be missing a
  // token that was saved after it loaded; minting from that copy replaces
  // the sticker. A token already on the document is the one that is printed.
  let qrToken = ''
  await runTransaction(db, async (tx) => {
    const ref = fasRef(asset.id)
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('Fire-alarm device not found')
    const stored = snap.data() || {}
    const existing = String(stored.qrToken || '').trim()
    qrToken = existing || generateQrToken()
    if (!existing) tx.update(ref, { qrToken, updatedAt: serverTimestamp() })
    tx.set(qrRef(qrToken), fasMirror(orgName, asset.id, { ...stored, ...asset, qrToken }))
  })
  await logAudit(actor, 'fas.qr_generate', { target: 'fas', targetId: asset.id, targetLabel: `${asset.deviceId || asset.deviceType} @ ${asset.centerName}`, summary: 'QR code generated' })
  return qrToken
}

/**
 * Give every live control panel that has no QR code one, and publish its mirror.
 *
 * Reads the org's own `fas` collection — the register on screen is capped, and
 * the panels missing a code are the ones added before this existed, which are
 * the oldest and the first a cap would drop. A panel that already has a token
 * is not written. The read is repeated inside the transaction, so a code that
 * landed between the list and the write is left as it is rather than replaced.
 *
 * Returns how many panels were given a code.
 */
export async function backfillFasPanelQr(orgName, actor) {
  const snap = await getDocs(fasCol())
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  const { assign, kept } = planFasPanelQrBackfill(rows)
  if (!assign.length) return { assigned: 0, kept: kept.length, scanned: rows.length }

  let assigned = 0
  for (let i = 0; i < assign.length; i += 20) {
    const wrote = await Promise.all(
      assign.slice(i, i + 20).map((row) => assignMissingFasPanelQr(orgName, row.id)),
    )
    assigned += wrote.filter(Boolean).length
  }
  if (assigned) {
    await logAudit(actor, 'fas.qr_backfill', {
      target: 'fas',
      summary: `Generated QR codes for ${assigned} control panel(s) that had none`,
    })
  }
  return { assigned, kept: kept.length, scanned: rows.length }
}

async function assignMissingFasPanelQr(orgName, id) {
  let written = null
  await runTransaction(db, async (tx) => {
    written = null
    const ref = fasRef(id)
    const snap = await tx.get(ref)
    if (!snap.exists()) return
    const data = snap.data() || {}
    // The list can be stale. A token that appeared since is the sticker; this
    // transaction's job is to notice that and write nothing.
    if (String(data.qrToken || '').trim()) return
    if (data.deletedAt) return
    if (!isFasControlPanel(data)) return
    const qrToken = generateQrToken()
    tx.update(ref, { qrToken, updatedAt: serverTimestamp() })
    tx.set(qrRef(qrToken), fasMirror(orgName, id, { ...data, qrToken }))
    written = qrToken
  })
  return written
}

/** One FAS device, including a row the capped register listing did not load. */
export async function getFas(id) {
  if ((!id)) return null
  const snap = await getDoc(fasRef(id))
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
}

/** Log a service: stamps last service today, sets the next due, marks Operational. */
export async function serviceFas(orgName, asset, nextService, actor) {
  const today = todayISO()
  const merged = { ...asset, lastService: today, nextService: nextService || '', status: 'operational' }
  const a = { ...cleanFas(merged), updatedAt: serverTimestamp() }
  const batch = writeBatch(db)
  batch.update(fasRef(asset.id), a)
  if (asset.qrToken) batch.set(qrRef(asset.qrToken), fasMirror(orgName, asset.id, { ...merged, qrToken: asset.qrToken }))
  await batch.commit()
  await logAudit(actor, 'fas.service', { target: 'fas', targetId: asset.id, targetLabel: `${asset.deviceId || asset.deviceType} @ ${asset.centerName}`, summary: `FAS serviced — next service ${nextService || '—'}` })
}

export async function deleteFas(id, qrToken, actor, label) {
  await retireAssets([{ id, qrToken }], fasRef, actor)
  await logAudit(actor, 'fas.delete', {
    target: 'fas', targetId: id, targetLabel: label || '',
    summary: `${label || 'FAS device'} moved to Recently deleted`,
  })
}

/** Soft-delete FAS devices by [{id, qrToken}]. The QR mirror stays until purge. */
export async function bulkDeleteFas(items, actor) {
  await retireAssets(items, fasRef, actor)
  await logAudit(actor, 'fas.bulk_delete', {
    target: 'fas', summary: `${items.length} FAS device(s) moved to Recently deleted`,
  })
}

const fasLabelOf = (a) => `${a?.deviceId || a?.deviceType || 'FAS'} @ ${a?.centerName || ''}`

export async function restoreFasMany(orgName, ids, actor) {
  return reviveAssets(orgName, 'fas', ids, actor, {
    refOf: fasRef, colOf: fasCol, mirror: fasMirror, audit: 'fas.restore', labelOf: fasLabelOf,
  })
}

export async function restoreFas(orgName, id, actor) {
  return restoreFasMany(orgName, [id], actor)
}

export async function purgeFas(id, qrToken, actor, label) {
  const batch = writeBatch(db)
  batch.delete(fasRef(id))
  if (qrToken) batch.delete(qrRef(qrToken))
  await batch.commit()
  await logAudit(actor, 'fas.purge', { target: 'fas', targetId: id, targetLabel: label || '' })
}

// ── AED / FAS public defect reports (submitted from a QR scan) ─────────────────
/** Create a pending asset-defect report (public QR scan). Lands in Approvals. */
export async function createAssetReport({ assetKind, assetRefId, assetLabel, defect, token, reporterRole, note }) {
  await addDoc(reportCol(), {
    kind: 'asset_defect',
    assetKind,
    assetRefId,
    assetLabel: assetLabel || '',
    defect,
    token: token || '',
    approvalStatus: 'pending',
    source: 'qr',
    reportedBy: 'public',
    reportedByName: 'QR Scan (Public)',
    // Same two fields an extinguisher report carries, because the Approvals card
    // reads them off the report regardless of kind — without them an AED or panel
    // fault arrives anonymous next to a fully attributed extinguisher one.
    reporterRole: reporterRole || null,
    note: note || '',
    reportedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
  })
}

/**
 * Where an approved defect lands, per asset kind.
 *
 * A table rather than the `isFas ? fasRef : aedRef` ternary this replaces. That
 * ternary had no third answer: any kind that was not 'fas' updated the AED
 * collection, so a stretcher report would have written to an AED document id
 * that does not exist there — a failed batch surfacing as "could not update the
 * report", with nothing naming the real cause. An unknown kind is refused here
 * instead, and says which one it was.
 */
const ASSET_TARGETS = {
  aed: { ref: aedRef, faultStatus: 'out_of_service', faultLabel: 'Out of service' },
  fas: { ref: fasRef, faultStatus: 'faulty', faultLabel: 'Faulty' },
  stretcher: { ref: stretcherRef, faultStatus: 'out_of_service', faultLabel: 'Out of service' },
}

/** Approve (→ mark the asset Faulty/Out-of-service) or reject an asset-defect report. */
export async function decideAssetReport(report, approve, reviewerName, actor) {
  const target = ASSET_TARGETS[report.assetKind]
  if (!target) throw new Error(`Unknown asset kind "${report.assetKind || ''}" — this report cannot be actioned`)
  const batch = writeBatch(db)
  batch.update(reportRef(report.id), {
    approvalStatus: approve ? 'approved' : 'rejected',
    reviewedBy: reviewerName || '',
    reviewedAt: serverTimestamp(),
  })
  if (approve && report.assetRefId) {
    batch.update(target.ref(report.assetRefId), { status: target.faultStatus, updatedAt: serverTimestamp() })
    if (report.token) batch.update(qrRef(report.token), { status: target.faultStatus, updatedAt: serverTimestamp() })
  }
  await batch.commit()
  await logAudit(actor, `${report.assetKind}.defect_${approve ? 'approved' : 'rejected'}`, {
    target: report.assetKind, targetId: report.assetRefId || '', targetLabel: report.assetLabel || '',
    summary: `${report.defect}${approve ? ` — marked ${target.faultLabel}` : ' — dismissed'}`,
  })
}

// ── AED / FAS bulk create (from spreadsheet upload) ───────────────────────────
// Each row writes the asset doc + its public QR mirror (2 ops); chunk under the
// 500-op Firestore batch limit.
const BULK_CHUNK = 200

/**
 * Reserve `count` asset ids for a register, in one transaction.
 *
 * These were computed in the browser: nextAssetId() took the highest number in
 * the loaded list and added one. Two people opening Add AED at the same moment
 * both got AED-0042, and generateAll handed out base+1+i for a whole batch with
 * no reservation at all — while the list it counted from is itself truncated at
 * COLLECTION_READ_CAP, so a unit past the cap was invisible to the arithmetic.
 * assetId is the handle printed on the QR label, and nothing downstream dedupes.
 *
 * `floor` is the highest number the caller can see, which is what seeds a
 * counter starting at zero against a register full of assets numbered before it
 * existed. On a register already past the read cap that floor can understate on
 * the FIRST reservation; the counter is monotonic, so it self-corrects from
 * there and cannot drift again. That is a one-time edge in place of a collision
 * on every concurrent add.
 */
export async function reserveAssetIds(kind, prefix, { count = 1, floor = 0 } = {}) {
  const first = await reserveSeq(kind, { count, floor })
  return Array.from({ length: count }, (_, i) => formatAssetId(prefix, first + i))
}
export async function bulkAddAeds(orgName, rows, actor) {
  let created = 0
  for (let i = 0; i < rows.length; i += BULK_CHUNK) {
    const batch = writeBatch(db)
    for (const row of rows.slice(i, i + BULK_CHUNK)) {
      const ref = doc(aedCol())
      const qrToken = generateQrToken()
      const a = { ...cleanAed(row), qrToken, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
      batch.set(ref, a)
      batch.set(qrRef(qrToken), aedMirror(orgName, ref.id, a))
      created++
    }
    await batch.commit()
  }
  await logAudit(actor, 'aed.bulk_create', { target: 'aed', summary: `Bulk added ${created} AED(s)` })
  return { created }
}

export async function bulkAddFas(orgName, rows, actor) {
  // Same rule as addFas: a control panel is created with a QR, and a token
  // the row already carries is the one that gets stored. Detectors, MCPs and
  // hooters are created without one — the panel's code covers the system.
  // This is the Excel import and the "generate a panel per site" action.
  let created = 0
  for (let i = 0; i < rows.length; i += BULK_CHUNK) {
    const batch = writeBatch(db)
    for (const row of rows.slice(i, i + BULK_CHUNK)) {
      const ref = doc(fasCol())
      const clean = cleanFas(row)
      const qrToken = fasQrTokenForCreate(
        { ...clean, qrToken: row.qrToken, qrLink: row.qrLink },
        generateQrToken,
      )
      const a = {
        ...clean,
        ...(qrToken ? { qrToken } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }
      batch.set(ref, a)
      if (qrToken) batch.set(qrRef(qrToken), fasMirror(orgName, ref.id, a))
      created++
    }
    await batch.commit()
  }
  await logAudit(actor, 'fas.bulk_create', { target: 'fas', summary: `Bulk added ${created} FAS device(s)` })
  return { created }
}
