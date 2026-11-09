// ─────────────────────────────────────────────────────────────────────────────
// CCTV inventory persistence.
//
// Three org-scoped collections, one per layer of the chain. They are kept apart
// rather than folded into one "devices" collection because the questions asked
// of them differ: a camera is asked where it points, a DVR how many channels it
// has and what it records to, a Meraki which site it carries. Merging them would
// mean a document where two thirds of the fields are always blank.
//
// No document ids here. Following the precedent set for fire equipment in
// shared/docId/format.js: a camera already carries an asset tag identifying the
// physical thing that was bought, and a generated number would give two answers
// to "which camera is this".
// ─────────────────────────────────────────────────────────────────────────────

import {
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit, serverTimestamp,
  writeBatch, getDocs,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { isSessionEnd } from '../../../shared/sessionEnd'
import { isPermissionDenied } from '../../../shared/lib/permissionDenied'
import { logAudit, COLLECTION_READ_CAP } from '../../../shared/org/orgData'
import { standardMerakiPayloads, merakiDocId } from './provision'
import { asReportedOn } from './defectDate'

export const COLLECTIONS = {
  cameras: 'cctvCameras',
  dvrs: 'cctvDvrs',
  merakis: 'cctvMeraki',
}

const col = (orgId, name) => collection(db, 'organizations', orgId, name)
const ref = (orgId, name, id) => doc(db, 'organizations', orgId, name, id)

/** Live list, newest names first. Returns the unsubscribe. */
function subscribe(orgId, name, cb) {
  if (!orgId) return () => {}
  // orderBy('name') rather than a timestamp: these are read as an equipment
  // register, where people scan for a device by its label, not by when it was
  // added. Documents missing the field are dropped by Firestore's ordering, so
  // every writer below always sets it.
  // Capped like every other live register in the app. A camera estate is the
  // one inventory here that genuinely can run to thousands, and an uncapped
  // listener bills a document read for every one of them on every page load.
  const q = query(col(orgId, name), orderBy('name'), limit(COLLECTION_READ_CAP))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    // A listener that dies silently leaves the page showing an empty estate,
    // which reads as "no cameras" rather than "not loaded".
    (err) => {
      if (!isSessionEnd(name, err) && !isPermissionDenied(err)) {
        // eslint-disable-next-line no-console
        console.error(`[CCTV] ${name} listener failed:`, err?.message || err)
      }
      cb(null, err)
    }
  )
}

export const subscribeCameras = (orgId, cb) => subscribe(orgId, COLLECTIONS.cameras, cb)
export const subscribeDvrs = (orgId, cb) => subscribe(orgId, COLLECTIONS.dvrs, cb)
export const subscribeMerakis = (orgId, cb) => subscribe(orgId, COLLECTIONS.merakis, cb)

// ── Shape normalisation ──────────────────────────────────────────────────────
// Firestore rejects `undefined`, and a half-filled form produces plenty of it.
// Every writer runs its input through one of these so a missing optional field
// becomes '' rather than an exception halfway through a bulk import.

const str = (v) => String(v ?? '').trim()
const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])

/**
 * The defect list and the date it was reported, written as one fact.
 *
 * They are shaped together because neither is true without the other. A date
 * left behind by a cleared defect describes nothing, and would still be counted
 * by anything that reads the field — so it goes when the last defect goes.
 * `offline` never survives either: it is derived from connectivity in health.js
 * and storing it is how a streaming camera stays flagged offline forever.
 */
const defectFields = (d) => {
  const defects = list(d.defects).filter((x) => x !== 'offline')
  return { defects, defectReportedOn: defects.length ? asReportedOn(d.defectReportedOn) : '' }
}

const cameraShape = (d) => ({
  name: str(d.name),
  location: str(d.location),
  dvrId: str(d.dvrId),
  siteId: str(d.siteId),
  siteName: str(d.siteName),
  status: str(d.status) || 'unknown',
  ...defectFields(d),
  make: str(d.make),
  model: str(d.model),
  channel: str(d.channel),
  notes: str(d.notes),
})

const dvrShape = (d) => ({
  name: str(d.name),
  ipAddress: str(d.ipAddress),
  siteId: str(d.siteId),
  siteName: str(d.siteName),
  status: str(d.status) || 'unknown',
  ...defectFields(d),
  channels: Number(d.channels) || 0,
  make: str(d.make),
  model: str(d.model),
  location: str(d.location),
  notes: str(d.notes),
})

const merakiShape = (d) => ({
  name: str(d.name),
  ipAddress: str(d.ipAddress),
  siteId: str(d.siteId),
  siteName: str(d.siteName),
  status: str(d.status) || 'unknown',
  ...defectFields(d),
  model: str(d.model),
  serial: str(d.serial),
  notes: str(d.notes),
})

const SHAPES = {
  [COLLECTIONS.cameras]: cameraShape,
  [COLLECTIONS.dvrs]: dvrShape,
  [COLLECTIONS.merakis]: merakiShape,
}

const LABELS = {
  [COLLECTIONS.cameras]: 'camera',
  [COLLECTIONS.dvrs]: 'DVR',
  [COLLECTIONS.merakis]: 'Meraki device',
}

// ── Writes ───────────────────────────────────────────────────────────────────

async function create(orgId, name, data, actor) {
  const payload = SHAPES[name](data)
  if (!payload.name) throw new Error(`Give the ${LABELS[name]} a name`)
  const created = await addDoc(col(orgId, name), {
    ...payload,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  await logAudit(orgId, actor, 'cctv.create', {
    target: name, targetId: created.id, targetLabel: payload.name,
    summary: `Added ${LABELS[name]} ${payload.name}`,
  })
  return created.id
}

async function update(orgId, name, id, data, actor) {
  const payload = SHAPES[name](data)
  await updateDoc(ref(orgId, name, id), { ...payload, updatedAt: serverTimestamp() })
  await logAudit(orgId, actor, 'cctv.update', {
    target: name, targetId: id, targetLabel: payload.name,
    summary: `Updated ${LABELS[name]} ${payload.name}`,
  })
}

async function remove(orgId, name, id, label, actor) {
  await deleteDoc(ref(orgId, name, id))
  await logAudit(orgId, actor, 'cctv.delete', {
    target: name, targetId: id, targetLabel: label,
    summary: `Removed ${LABELS[name]} ${label}`,
  })
}

export const addCamera = (orgId, d, actor) => create(orgId, COLLECTIONS.cameras, d, actor)
export const updateCamera = (orgId, id, d, actor) => update(orgId, COLLECTIONS.cameras, id, d, actor)
export const deleteCamera = (orgId, id, label, actor) => remove(orgId, COLLECTIONS.cameras, id, label, actor)

export const addDvr = (orgId, d, actor) => create(orgId, COLLECTIONS.dvrs, d, actor)
export const updateDvr = (orgId, id, d, actor) => update(orgId, COLLECTIONS.dvrs, id, d, actor)
export const deleteDvr = (orgId, id, label, actor) => remove(orgId, COLLECTIONS.dvrs, id, label, actor)

export const addMeraki = (orgId, d, actor) => create(orgId, COLLECTIONS.merakis, d, actor)
export const updateMeraki = (orgId, id, d, actor) => update(orgId, COLLECTIONS.merakis, id, d, actor)
export const deleteMeraki = (orgId, id, label, actor) => remove(orgId, COLLECTIONS.merakis, id, label, actor)

/**
 * Write validated import rows.
 *
 * Only rows that passed validation should reach here — the caller filters. They
 * are shaped again anyway, because this is the last place before Firestore and
 * a normaliser that only runs on the happy path is one that eventually does not.
 *
 * Chunked at 400 against the 500-write batch cap. Chunks commit independently:
 * a 900-row import that fails on the third chunk leaves the first 800 in place
 * rather than discarding the lot, and re-running skips them by name.
 */
export async function bulkImport(orgId, kind, rows = [], actor) {
  const name = COLLECTIONS[kind]
  if (!name) throw new Error(`Unknown device kind ${kind}`)
  if (!rows.length) return 0

  const CHUNK = 400
  let written = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = writeBatch(db)
    for (const r of rows.slice(i, i + CHUNK)) {
      batch.set(doc(col(orgId, name)), {
        ...SHAPES[name](r),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    }
    await batch.commit()
    written += Math.min(CHUNK, rows.length - i)
  }

  await logAudit(orgId, actor, 'cctv.import', {
    target: name,
    targetLabel: `${written} ${LABELS[name]}(s)`,
    summary: `Imported ${written} ${LABELS[name]}(s)`,
  })
  return written
}

/** One-shot read of the Meraki list, for callers with no live subscription. */
export async function getMerakis(orgId) {
  const snap = await getDocs(col(orgId, COLLECTIONS.merakis))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

/**
 * React to sites being created by giving each one its standard Meraki.
 *
 * Registered as a site hook at app start (see registerHooks.js), so it runs
 * whether or not anyone has opened the CCTV module.
 *
 * Nothing is passed as "already known": provisionSiteMerakis reads the
 * collection itself, and a second, staler view of it handed in from here could
 * only make the answer worse.
 */
export async function provisionMerakisForNewSites(orgId, sites = [], actor) {
  return provisionSiteMerakis(orgId, sites, [], actor)
}

/**
 * Give every site its standard Meraki device.
 *
 * Idempotent, and idempotent in three separate places because one was not
 * enough — this ran twice and left sites carrying two switches, which is not
 * cosmetic: darkSites() only marks a site dark when EVERY Meraki on it is
 * offline, so a phantom second switch sitting at `unknown` keeps a genuinely
 * dark site reading as healthy. A duplicate does not merely clutter the
 * register, it disables the cascade the register exists to drive.
 *
 *  1. The Meraki list is READ HERE rather than taken from the caller. It used
 *     to be an argument, and the Inventory button passed a live-listener
 *     snapshot React had rendered into a button some time earlier — stale by
 *     construction, and blind to another manager, another tab, or the
 *     site-created hook running at that moment. `merakis` is still accepted and
 *     still honoured, but only ever to ADD to what the read found.
 *  2. Sites are deduplicated against each other, not only against the
 *     collection (see sitesMissingMeraki), so one run cannot emit two.
 *  3. The documents are addressed BY SITE, not by auto-id. Two runs that
 *     genuinely overlap — both reads returning before either write lands — then
 *     converge on one document instead of racing to create two. This is the
 *     only one of the three that survives concurrency, because it is the only
 *     one enforced where the write happens rather than before it.
 *
 * Batched because a whole estate is created at once and half a provisioning run
 * is worse than none: it would leave some sites covered and some not, with no
 * way to tell which from looking.
 *
 * @returns the number created — 0 means everything was already covered
 */
export async function provisionSiteMerakis(orgId, sites = [], merakis = [], actor) {
  if (!orgId || !sites.length) return 0

  const known = await getMerakis(orgId)
  const payloads = standardMerakiPayloads(sites, [...known, ...merakis])
  if (!payloads.length) return 0

  // A document already sitting at the address about to be written is left
  // alone. That should be impossible after the siteId check above, but the two
  // guards fail differently: this one still holds for a record whose siteId was
  // cleared by hand, where the check above sees an uncovered site and would
  // otherwise overwrite the very record it was looking for.
  const taken = new Set(known.map((m) => m.id))
  const writes = payloads
    .map((payload) => ({ payload, id: merakiDocId(payload.siteId) }))
    .filter((w) => !w.id || !taken.has(w.id))
  if (!writes.length) return 0

  // Firestore caps a batch at 500 writes; an estate could exceed that.
  const CHUNK = 400
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = writeBatch(db)
    for (const w of writes.slice(i, i + CHUNK)) {
      // No usable id means the site id cannot go in a path. Fall back to an
      // auto-id rather than skipping the site, which would leave it with no
      // switch at all — the failure this whole file exists to prevent.
      const target = w.id
        ? doc(col(orgId, COLLECTIONS.merakis), w.id)
        : doc(col(orgId, COLLECTIONS.merakis))
      batch.set(target, {
        ...merakiShape(w.payload),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    }
    await batch.commit()
  }

  await logAudit(orgId, actor, 'cctv.provision', {
    target: COLLECTIONS.merakis,
    targetLabel: `${writes.length} site(s)`,
    summary: `Created the standard Meraki device for ${writes.length} site(s)`,
  })
  return writes.length
}

/**
 * Set a device's reported status — the one field a monitoring integration would
 * write, kept separate from the full update so a status poll cannot clobber the
 * inventory fields a person maintains by hand.
 */
export async function setStatus(orgId, kind, id, status, actor, label) {
  const name = COLLECTIONS[kind]
  if (!name) throw new Error(`Unknown device kind ${kind}`)
  await updateDoc(ref(orgId, name, id), {
    status: str(status) || 'unknown',
    statusAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  await logAudit(orgId, actor, 'cctv.status', {
    target: name, targetId: id, targetLabel: label || id,
    summary: `${LABELS[name]} ${label || id} marked ${status}`,
  })
}

/**
 * Raise or clear the observed defects on a device, and say when they were found.
 *
 * The two travel together deliberately. `updatedAt` is set by every edit to
 * every field, so it can never stand in for a defect date; `defectReportedOn`
 * only moves when this runs, which is what makes it worth counting by month.
 *
 * The audit line carries the reported date as well as the write time, because
 * those are different facts and the gap between them is the point: a defect
 * found on a Friday walk-round is often typed in the following Monday.
 */
export async function setDefects(orgId, kind, id, { defects, defectReportedOn } = {}, actor, label) {
  const name = COLLECTIONS[kind]
  if (!name) throw new Error(`Unknown device kind ${kind}`)
  const clean = defectFields({ defects, defectReportedOn })
  await updateDoc(ref(orgId, name, id), { ...clean, updatedAt: serverTimestamp() })
  await logAudit(orgId, actor, 'cctv.defects', {
    target: name, targetId: id, targetLabel: label || id,
    summary: clean.defects.length
      ? `${LABELS[name]} ${label || id}: ${clean.defects.join(', ')}${
          clean.defectReportedOn ? ` (reported ${clean.defectReportedOn})` : ' (no report date)'
        }`
      : `${LABELS[name]} ${label || id}: defects cleared`,
  })
}
