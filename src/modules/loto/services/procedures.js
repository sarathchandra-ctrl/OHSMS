import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  writeBatch,
  limit,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { putFile, removeFile, fileUrl } from '../../../shared/storage'
import { PROCEDURE_STATUS, computeLockSummary, mergeRevisedPoints } from '../constants/procedures'
import { PUBLIC_COL, publicProcedure } from '../utils/publicProcedure'
import { COLLECTION_READ_CAP } from '../../../shared/org/orgData'
import {
  assertClaimsFree,
  lockNosHeldBy,
  readClaims,
  releaseClaims,
  takeClaims,
} from './lockClaims'

const COL = 'procedures'
const PHOTOS = 'procedurePhotos'

/**
 * The public mirror a scanned procedure QR reads (see utils/publicProcedure).
 *
 * Every writer below updates it in the SAME batch or transaction as the
 * procedure itself. That is the whole safety property: a mirror written
 * separately can be left behind by a failure between the two writes, and a
 * stale one tells someone standing at a machine that it is isolated when the
 * lock has already come off. Atomic or it is worse than nothing.
 */
export const publicRef = (id) => doc(db, PUBLIC_COL, id)
export const publicBody = (procedure) => ({ ...publicProcedure(procedure), updatedAt: serverTimestamp() })

/**
 * Refuse to touch a procedure a live LOTO permit has locked.
 *
 * While a permit is active the locks on its equipment are the permit's: they
 * come off through the permit's return (or the Admin's emergency removal),
 * which also clears this marker, releases the padlock claims and records the
 * checklist. An unlock from the Operations screen would leave the permit
 * "active" over a machine whose locks are gone — the disagreement the permit
 * and the procedure are written in one transaction to prevent. Approving a
 * procedure is a manager's decision on the server (DECISION_STATES).
 */
export function assertNotHeldByPermit(procedure) {
  const held = procedure?.activePermit
  if (held) {
    throw new Error(
      `This equipment is isolated under permit ${held.permitNo || held.id}. Return or remove that permit first.`,
    )
  }
}

/**
 * Move fresh captures (data: URLs) to cloud storage; stored values become
 * { url, path } objects. Values that are already https strings are re-matched
 * against the previous stored map so their paths survive an edit round-trip
 * (the read seam hands pages plain URLs, and pages hand them straight back).
 * Anything unmatched stays inline — the pre-storage behaviour.
 */
async function resolvePhotoMap(incoming = {}, prevRaw = {}) {
  const out = {}
  for (const [key, v] of Object.entries(incoming)) {
    if (!v) continue
    if (typeof v === 'object' && (v.url || v.path)) { out[key] = { url: v.url || '', path: v.path || '' }; continue }
    const s = String(v)
    if (s.startsWith('data:')) {
      const up = await putFile('loto-photos', s, key + '.jpg')
      out[key] = up ? { url: up.url, path: up.path } : s
      continue
    }
    const prev = prevRaw[key]
    out[key] = (prev && typeof prev === 'object' && prev.url === s) ? prev : s
  }
  // Cloud files dropped or replaced in this edit have nothing left pointing at
  // them once the new map is written.
  for (const [key, v] of Object.entries(prevRaw)) {
    if (v && typeof v === 'object' && v.path) {
      const kept = out[key]
      if (!(kept && typeof kept === 'object' && kept.path === v.path)) removeFile(v.path)
    }
  }
  return out
}

async function rawPhotoMap(id) {
  try {
    const snap = await getDoc(doc(db, PHOTOS, id))
    return snap.exists() ? snap.data().photos || {} : {}
  } catch { return {} }
}
const EVENTS = 'lotoEvents'

/** Pre-generate a procedure document id so a draft can be referenced early. */
export function newProcedureId() {
  return doc(collection(db, COL)).id
}

// Strip transient/photo fields off isolation points before persisting the main
// doc; photos live in a separate (heavier) document so dashboards stay light.
function sanitizePoints(points = []) {
  return points.map(({ photo, ...p }) => ({ ...p, hasPhoto: Boolean(photo || p.hasPhoto) }))
}

/** Create a brand-new procedure (status: draft) + its photos doc. */
export async function createProcedure(id, data, user, photos = {}) {
  const resolvedPhotos = await resolvePhotoMap(photos, {})
  const points = sanitizePoints(data.isolationPoints || [])
  const body = {
    ...data,
    isolationPoints: points,
    revision: 0,
    status: PROCEDURE_STATUS.DRAFT,
    lockSummary: computeLockSummary(points),
    createdBy: user.id,
    createdByName: user.displayName,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
  }
  const batch = writeBatch(db)
  batch.set(doc(db, COL, id), body)
  batch.set(publicRef(id), publicBody(body))
  batch.set(doc(db, PHOTOS, id), {
    photos: resolvedPhotos,
    updatedAt: serverTimestamp(),
  })
  await batch.commit()
  return id
}

/** Save a revision: bumps revision, resets to draft, replaces photos. */
export async function reviseProcedure(id, data, user, photos = {}) {
  const resolvedPhotos = await resolvePhotoMap(photos, await rawPhotoMap(id))
  const snap = await getDoc(doc(db, COL, id))
  const current = snap.data() || {}
  assertNotHeldByPermit(current)

  // A revision replaces the point set with what the form submitted, and those
  // points carry no lockState. Carrying the live one across is what stops a
  // revision erasing a lockout that is physically still on the equipment.
  const { points, droppedLocked } = mergeRevisedPoints(
    sanitizePoints(data.isolationPoints || []),
    current.isolationPoints || [],
  )
  if (droppedLocked.length) {
    throw new Error(
      `Remove the lock on ${droppedLocked.join(', ')} before deleting ${droppedLocked.length === 1 ? 'that point' : 'those points'}.`,
    )
  }

  const body = {
    ...data,
    isolationPoints: points,
    revision: (current.revision ?? 0) + 1,
    status: PROCEDURE_STATUS.DRAFT,
    // WITH the group lock, like every other writer. Without it a revision made
    // during an active group lockout recomputed the status as though the group
    // had gone home.
    lockSummary: computeLockSummary(points, current.groupLock),
    revisedBy: user.id,
    revisedByName: user.displayName,
    updatedAt: serverTimestamp(),
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
  }
  const batch = writeBatch(db)
  batch.update(doc(db, COL, id), body)
  // set, not update: a revision replaces the point set wholesale, and a
  // procedure that predates the mirror has none to update.
  batch.set(publicRef(id), publicBody({ ...current, ...body }))
  batch.set(doc(db, PHOTOS, id), {
    photos: resolvedPhotos,
    updatedAt: serverTimestamp(),
  })
  await batch.commit()
}

export async function deleteProcedure(procedure) {
  assertNotHeldByPermit(procedure)
  const batch = writeBatch(db)
  batch.delete(doc(db, COL, procedure.id))
  // The mirror goes with it, in the same batch. A mirror outliving its
  // procedure is a public page still describing an isolation that no longer
  // exists — the one state worse than the code leading nowhere.
  batch.delete(publicRef(procedure.id))
  // And every padlock it was holding. A claim whose procedure no longer exists
  // can be released from nowhere in the app — the procedure is the only screen
  // that knows about it — so the padlock would be permanently unusable, which
  // is the same "stuck lock" failure the defect-lock sweep exists to undo.
  releaseClaims(batch, lockNosHeldBy(procedure))
  // Cloud photo files go with the photos doc — it is their only index.
  const raw = await rawPhotoMap(procedure.id)
  for (const v of Object.values(raw)) {
    if (v && typeof v === 'object' && v.path) removeFile(v.path)
  }
  batch.delete(doc(db, PHOTOS, procedure.id))
  await batch.commit()
}

/**
 * Photos map { [pointKey]: src } for a procedure (empty object if none).
 * Normalised to plain strings — inline data: URL or cloud https URL — so every
 * consumer (point editor, operate view, PDF) keeps its contract from before
 * storage existed.
 */
export async function getProcedurePhotos(id) {
  const raw = await rawPhotoMap(id)
  const out = {}
  // Resolve at the seam, so neither the view nor the PDF generator changes.
  //
  // This used to be `typeof v === 'object' ? v.url : v`, and `v.url` was a
  // Firebase download URL — a permanent bearer credential, filed in a document,
  // working for anyone holding it forever (audit finding M-5). Uploads no longer
  // mint one, so that expression now yields '' for every photo stored after the
  // change and every isolation point renders blank.
  //
  // `fileUrl` prefers an authenticated fetch by `path` and falls back to the
  // stored url, so procedures photographed before the change are unaffected.
  // Both consumers still receive a plain string.
  //
  // The blob: URLs this creates are not revoked. `resolveFiles.js` explains why
  // that matters for a gallery; here it is a handful of isolation points on a
  // page somebody reads once before working on a machine, so the leak is bounded
  // and the alternative — a revoke contract through the PDF generator — is not
  // worth what it would cost the one output people rely on for compliance.
  await Promise.all(Object.entries(raw).map(async ([k, v]) => {
    if (!v) return
    if (typeof v !== 'object') { out[k] = v; return }
    const { url } = await fileUrl(v)
    out[k] = url || ''
  }))
  return out
}

/**
 * A lifecycle status change, carried through to the public mirror.
 *
 * Reads the procedure first and rebuilds the mirror in full rather than
 * patching `status` onto it. Costs one extra read on a rare action, and buys
 * two things: a procedure that predates the mirror gets a complete one instead
 * of a document holding a status and no isolation points, and there is only
 * ever one expression of what the mirror contains.
 *
 * `extra` may carry serverTimestamp() sentinels, so it goes to the procedure
 * only — the mirror is built from the stored data plus the new status.
 */
async function setProcedureStatus(id, status, extra = {}) {
  const snap = await getDoc(doc(db, COL, id))
  if (snap.exists()) assertNotHeldByPermit(snap.data())
  const batch = writeBatch(db)
  batch.update(doc(db, COL, id), { status, ...extra, updatedAt: serverTimestamp() })
  if (snap.exists()) batch.set(publicRef(id), publicBody({ ...snap.data(), status }))
  await batch.commit()
}

export async function sendForApproval(id) {
  await setProcedureStatus(id, PROCEDURE_STATUS.PENDING_APPROVAL)
}

export async function approveProcedure(id, user) {
  await setProcedureStatus(id, PROCEDURE_STATUS.APPROVED, {
    approvedBy: user.id,
    approvedByName: user.displayName,
    approvedAt: serverTimestamp(),
  })
}

export async function rejectProcedure(id) {
  await setProcedureStatus(id, PROCEDURE_STATUS.REJECTED)
}

/**
 * Lock or unlock a single isolation point. Records who/when for both apply and
 * remove, keeps the last lock time, and appends to a capped audit history.
 * Runs in a transaction to avoid lost updates.
 */
export async function setPointLock(procedureId, pointKey, locked, user, tech = null) {
  const ref = doc(db, COL, procedureId)
  const eventRef = doc(collection(db, EVENTS))
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('Procedure not found')
    const data = snap.data()
    assertNotHeldByPermit(data)
    // Approval gates APPLYING a lock, never removing one.
    //
    // It used to gate both, and revising a procedure resets it to draft — so a
    // revision made while equipment was locked left padlocks that the system
    // refused to release, with the only way out being to re-approve a procedure
    // somebody was midway through editing. Nothing should ever stand between a
    // person and taking their own lock off; the reasons to refuse an unlock are
    // about lockout order (group members first), which is checked below.
    if (locked && data.status !== PROCEDURE_STATUS.APPROVED) {
      throw new Error('Procedure must be approved before performing LOTO')
    }
    // Primary technician: required when locking; reuse the procedure's primary
    // once set so the whole lockout is attributed to one technician.
    // Each point gets its own lock (no reuse of a single primary lock).
    const useTech = locked ? tech : null
    if (locked && !useTech) throw new Error('Select a technician to apply the lock')
    // Removal order: every group-lock technician must be removed before the
    // primary point lock can come off.
    if (
      !locked &&
      data.groupLock?.active &&
      (data.groupLock.members?.length || 0) > 0
    ) {
      throw new Error('Remove all group-lock technicians before removing the primary lock')
    }
    // Multiple isolation points require a Department lock.
    if (
      locked &&
      (data.isolationPoints || []).length > 1 &&
      useTech?.lockType !== 'department'
    ) {
      throw new Error('Multiple isolation points require a Department lock')
    }
    // Lock number must be unique: not already on another locked point, and not
    // held by a group-lock member anywhere in this procedure.
    if (locked && useTech?.lockNo) {
      const dupPoint = (data.isolationPoints || []).find(
        (p) => p.key !== pointKey && p.lockState?.locked && p.lockState.techLockNo === useTech.lockNo,
      )
      const dupGroup = (data.groupLock?.members || []).some((m) =>
        Object.values(m.locks || {}).includes(useTech.lockNo),
      )
      if (dupPoint || dupGroup) {
        throw new Error(`Lock ${useTech.lockNo} is already in use on this equipment`)
      }
    }

    // The check the two above cannot make: is this padlock on ANOTHER machine?
    // Both of them reason from this one procedure document, so neither can see
    // it. Read before any write — a transaction refuses a read once it has
    // written, and every claim this call needs is known by now.
    const held = locked && useTech?.lockNo
      ? await readClaims(tx, [useTech.lockNo])
      : []
    assertClaimsFree(held, procedureId)

    const at = new Date().toISOString()
    let target = null
    // The number coming OFF the equipment, so its claim can be released in this
    // same transaction. Only knowable from the point's previous state.
    let releasedLockNo = null
    const points = (data.isolationPoints || []).map((p) => {
      if (p.key !== pointKey) return p
      const prev = p.lockState || {}
      if (!locked) releasedLockNo = prev.techLockNo || null
      const lockState = locked
        ? {
            locked: true,
            lockedBy: user.id,
            lockedByName: user.displayName,
            lockedAt: at,
            techId: useTech?.techId || null,
            techName: useTech?.name || null,
            techLockNo: useTech?.lockNo || null,
            lockType: useTech?.lockType || null,
            unlockedBy: null,
            unlockedByName: null,
            unlockedAt: null,
          }
        : {
            locked: false,
            lockedBy: prev.lockedBy || null,
            lockedByName: prev.lockedByName || null,
            lockedAt: prev.lockedAt || null,
            techId: prev.techId || null,
            techName: prev.techName || null,
            techLockNo: prev.techLockNo || null,
            lockType: prev.lockType || null,
            unlockedBy: user.id,
            unlockedByName: user.displayName,
            unlockedAt: at,
          }
      target = { ...p, lockState }
      return target
    })

    const summary = computeLockSummary(points, data.groupLock)
    const update = {
      isolationPoints: points,
      lockSummary: summary,
      updatedAt: serverTimestamp(),
    }
    if (locked) {
      // Lead technician label only (first lock); not reused to apply locks.
      if (!data.primaryTech) update.primaryTech = useTech
    } else if (summary.lockedCount === 0) {
      // Fully unlocked → clear the lockout (primary + group lock).
      update.primaryTech = null
      update.groupLock = { active: false, method: null, members: [] }
    }
    tx.update(ref, update)
    // Same transaction as the lock itself — see publicRef. A lock that lands
    // without its mirror leaves the public page saying "unlocked" about a
    // machine somebody has just isolated, or worse, the reverse.
    tx.set(publicRef(procedureId), publicBody({ ...data, ...update }))

    // And the padlock claim, for the same reason. A claim written outside this
    // transaction can be stranded by a failure between the two writes: on the
    // taking side that reserves a lock nothing is holding, on the releasing
    // side it leaves a lock the system will not hand out again.
    const claimContext = {
      procedureId,
      procedureCode: data.procedureCode,
      equipment: data.equipment,
      site: data.site,
      holder: 'point',
      pointKey,
      techId: useTech?.techId || null,
      techName: useTech?.name || null,
      by: user.id,
      byName: user.displayName,
    }
    if (locked && useTech?.lockNo) takeClaims(tx, claimContext, [useTech.lockNo])
    if (!locked && releasedLockNo) releaseClaims(tx, [releasedLockNo])

    tx.set(eventRef, {
      procedureId,
      equipment: data.equipment || '',
      site: data.site || '',
      procedureCode: data.procedureCode || '',
      pointKey,
      pointId: target?.pointId || '',
      energy: target?.energyLabel || target?.energySource || '',
      action: locked ? 'lock' : 'unlock',
      techName: useTech?.name || null,
      by: user.id,
      byName: user.displayName,
      at: serverTimestamp(),
    })
  })
}

/**
 * Add an additional technician to a group lockout (equipment must be fully
 * locked). Two methods:
 *  - Group LOTO Box: the technician applies ONE personal padlock to the box —
 *    `member.boxLock = lockNo` (their dedicated lock).
 *  - Hasp: the technician applies a UNIQUE Department lock to every locked
 *    isolation point — `member.locks = { [pointKey]: lockNo }`.
 * `swaps = { [pointKey]: lockNo }` converts any personal primary lock to a
 * department lock (single-point case), freeing the personal lock.
 */
export async function addGroupMember(procedureId, member, method, user, swaps = {}) {
  const ref = doc(db, COL, procedureId)
  const eventRef = doc(collection(db, EVENTS))
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('Procedure not found')
    const data = snap.data()
    assertNotHeldByPermit(data)
    if (data.lockSummary?.status !== 'locked') {
      throw new Error('Equipment must be fully locked before adding group locks')
    }
    const group = data.groupLock?.active
      ? data.groupLock
      : { active: true, method, members: [] }
    if (group.members.some((m) => m.techId === member.techId)) {
      throw new Error('That technician is already on the group lock')
    }

    // Read every padlock this call might take, before the first write — a
    // transaction refuses a read once it has written, and which of these is
    // actually used is not settled until the member record is built below. A
    // superset costs one or two reads; getting the ordering wrong costs the
    // whole transaction.
    const held = await readClaims(tx, [
      member.boxLock,
      ...Object.values(member.locks || {}),
      ...Object.values(swaps || {}),
    ])

    const update = { updatedAt: serverTimestamp() }
    let points = data.isolationPoints || []
    let primaryTech = data.primaryTech || null

    // Personal locks coming OFF in a swap. Their claims are released in this
    // same transaction: a swapped-out personal lock is back in the technician's
    // pouch, and a claim outliving it would take that padlock out of service.
    const swappedOut = (data.isolationPoints || [])
      .filter((p) => p.lockState?.locked && swaps?.[p.key] && p.lockState.techLockNo)
      .map((p) => p.lockState.techLockNo)

    // Personal → department swaps on the named points (single-point case).
    if (swaps && Object.keys(swaps).length) {
      points = points.map((p) =>
        p.lockState?.locked && swaps[p.key]
          ? {
              ...p,
              lockState: { ...p.lockState, techLockNo: swaps[p.key], lockType: 'department' },
            }
          : p,
      )
      update.isolationPoints = points
      const swapVals = Object.values(swaps)
      if (swapVals.length && primaryTech?.lockType === 'personal') {
        primaryTech = { ...primaryTech, lockNo: swapVals[0], lockType: 'department' }
        update.primaryTech = primaryTech
      }
    }

    const effectiveMethod = group.method || method
    const lockedPoints = points.filter((p) => p.lockState?.locked)

    // All lock numbers already committed on this equipment (point locks + any
    // existing group members' box/per-point locks).
    const used = new Set()
    lockedPoints.forEach((p) => {
      if (p.lockState.techLockNo) used.add(p.lockState.techLockNo)
    })
    group.members.forEach((m) => {
      if (m.boxLock) used.add(m.boxLock)
      Object.values(m.locks || {}).forEach((no) => no && used.add(no))
    })

    // What this call actually puts on the equipment: the member's own locks,
    // plus any department lock a swap has just introduced.
    const taken = [...Object.values(swaps || {})]

    let memberRecord
    if (effectiveMethod === 'box') {
      // One personal padlock on the box.
      const no = member.boxLock
      if (!no) throw new Error('Select a technician with a personal lock for the box')
      if (used.has(no)) throw new Error(`Lock ${no} is already in use on this equipment`)
      taken.push(no)
      memberRecord = {
        techId: member.techId,
        name: member.name,
        joinedAt: new Date().toISOString(),
        boxLock: no,
      }
    } else {
      // Hasp: a unique department lock on every isolation point.
      const memberLocks = member.locks || {}
      const seen = new Set()
      for (const p of lockedPoints) {
        const no = memberLocks[p.key]
        if (!no) throw new Error('Select a Department lock for every isolation point')
        if (used.has(no) || seen.has(no)) {
          throw new Error(`Lock ${no} is already in use on this equipment`)
        }
        seen.add(no)
        taken.push(no)
      }
      memberRecord = {
        techId: member.techId,
        name: member.name,
        joinedAt: new Date().toISOString(),
        locks: memberLocks,
      }
    }

    const next = {
      active: true,
      method: effectiveMethod,
      members: [...group.members, memberRecord],
    }
    update.groupLock = next
    update.lockSummary = computeLockSummary(points, next)

    // Refuse the whole join if any of these padlocks is on another machine.
    // The `used` checks above only ever saw this equipment; this is the one
    // that reaches the next bay.
    assertClaimsFree(held.filter((h) => taken.includes(h.lockNo)), procedureId)

    tx.update(ref, update)
    tx.set(publicRef(procedureId), publicBody({ ...data, ...update }))
    releaseClaims(tx, swappedOut.filter((no) => !taken.includes(String(no))))

    const claimBase = {
      procedureId,
      procedureCode: data.procedureCode,
      equipment: data.equipment,
      site: data.site,
      by: user.id,
      byName: user.displayName,
    }
    // A swap does not give the department lock to the joining technician — it
    // re-labels the POINT's lock, which then outlives this member and is
    // released when the point is unlocked. Recording it as theirs would send an
    // investigator to the wrong person.
    takeClaims(tx, { ...claimBase, holder: 'point' }, Object.values(swaps || {}))
    takeClaims(
      tx,
      { ...claimBase, holder: 'group', techId: member.techId, techName: member.name },
      taken.filter((no) => !Object.values(swaps || {}).map(String).includes(String(no))),
    )
    tx.set(eventRef, {
      procedureId,
      equipment: data.equipment || '',
      site: data.site || '',
      procedureCode: data.procedureCode || '',
      pointKey: null,
      pointId: '',
      energy: `Group lock (${next.method === 'box' ? 'Group LOTO Box' : 'Hasp'})`,
      action: 'group_join',
      techName: member.name || null,
      by: user.id,
      byName: user.displayName,
      at: serverTimestamp(),
    })
  })
}

/** Remove a technician from the group lockout. */
export async function removeGroupMember(procedureId, techId, user) {
  const ref = doc(db, COL, procedureId)
  const eventRef = doc(collection(db, EVENTS))
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('Procedure not found')
    const data = snap.data()
    assertNotHeldByPermit(data)
    const group = data.groupLock || { active: false, method: null, members: [] }
    const removed = group.members?.find((m) => m.techId === techId)
    const members = (group.members || []).filter((m) => m.techId !== techId)
    const next = {
      active: members.length > 0,
      method: members.length > 0 ? group.method : null,
      members,
    }
    const update = {
      groupLock: next,
      lockSummary: computeLockSummary(data.isolationPoints || [], next),
      updatedAt: serverTimestamp(),
    }
    tx.update(ref, update)
    tx.set(publicRef(procedureId), publicBody({ ...data, ...update }))
    // The padlocks this technician takes home with them. Their point locks are
    // not touched: a hasp swap re-labelled those and they stay on the equipment
    // until the point itself is unlocked.
    releaseClaims(tx, [
      removed?.boxLock,
      ...Object.values(removed?.locks || {}),
    ])
    tx.set(eventRef, {
      procedureId,
      equipment: data.equipment || '',
      site: data.site || '',
      procedureCode: data.procedureCode || '',
      pointKey: null,
      pointId: '',
      energy: 'Group lock',
      action: 'group_leave',
      techName: removed?.name || null,
      by: user.id,
      byName: user.displayName,
      at: serverTimestamp(),
    })
  })
}

export async function getProcedure(id) {
  const snap = await getDoc(doc(db, COL, id))
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
}

export function subscribeProcedure(id, cb, onError) {
  return onSnapshot(
    doc(db, COL, id),
    (snap) => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onError,
  )
}

export function subscribeOrgEvents(cb, onError) {
  // Append-only LOTO activity log. No server-side orderBy (no index); sort by
  // timestamp on the client, newest first.
  const q = query(collection(db, EVENTS), limit(COLLECTION_READ_CAP))
  return onSnapshot(
    q,
    (snap) => {
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      items.sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0))
      cb(items)
    },
    onError,
  )
}

export function subscribeOrgProcedures(cb, onError) {
  // No server-side orderBy (avoids a composite index); sort on the client.
  const q = query(collection(db, COL), limit(COLLECTION_READ_CAP))
  return onSnapshot(
    q,
    (snap) => {
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      items.sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0))
      cb(items)
    },
    onError,
  )
}

/**
 * Give every existing procedure a public mirror.
 *
 * The nine writers above keep the mirror current from now on, and each rebuilds
 * it in full — so any procedure that is locked, approved or revised heals
 * itself. What none of them reaches is a procedure nobody touches: an approved
 * isolation on a machine that is simply working. Its printed code would resolve
 * to "does not match a current procedure", which is the wrong answer and, on a
 * LOTO code, an alarming one.
 *
 * Idempotent by construction — it rewrites from the procedure rather than
 * patching — so running it twice costs writes and changes nothing. `dryRun`
 * reports without writing, because the honest thing before a bulk write is to
 * say how many documents it will touch.
 *
 * Mirrors are checked one at a time rather than queried: `allow list: if false`
 * on /procedureQr means even an approved member cannot page it, which is the
 * property that stops a stranger walking off with every tenant's procedures.
 */
export async function backfillProcedureMirrors({ dryRun = true, max = 2000 } = {}) {
  const snap = await getDocs(query(collection(db, COL), limit(max)))
  const procedures = snap.docs.map((d) => ({ id: d.id, ...d.data() }))

  let present = 0
  const missing = []
  for (const p of procedures) {
    const m = await getDoc(publicRef(p.id))
    if (m.exists()) present += 1
    else missing.push(p.id)
  }

  const result = { total: procedures.length, present, missing: missing.length, ids: missing.slice(0, 20) }
  if (dryRun) return { ...result, written: 0 }

  // Firestore caps a batch at 500 operations.
  let written = 0
  for (let i = 0; i < procedures.length; i += 400) {
    const batch = writeBatch(db)
    for (const p of procedures.slice(i, i + 400)) {
      batch.set(publicRef(p.id), publicBody(p))
      written += 1
    }
    await batch.commit()
  }
  return { ...result, written }
}
