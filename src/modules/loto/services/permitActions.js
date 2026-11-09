// ─────────────────────────────────────────────────────────────────────────────
// Moving a permit through its life: decide, withdraw, start isolation, extend,
// return, emergency removal.
//
// THE RULE THIS FILE EXISTS FOR: a permit's lock state and its procedure's lock
// state are written in ONE Firestore transaction. Starting a permit flips the
// permit, locks every isolation point, stamps the procedure with
// `activePermit`, refreshes the public QR mirror, takes the padlock claims and
// appends the audit trail — all in a single commit, or none of it. Returning or
// removing does the reverse. There is no step at which the permit says "active"
// and the equipment says "unlocked", or the other way round, because there is no
// write that does one without the other. firestore.rules refuse the half-write
// as well (getAfter on the procedure), so a client that skips this file cannot
// reach the state either.
//
// Every read comes before the first write (Firestore refuses a read after a
// write), and every decision is made on documents read INSIDE the transaction,
// never on the copies on screen.
// ─────────────────────────────────────────────────────────────────────────────
import {
  collection,
  deleteField,
  doc,
  runTransaction,
  serverTimestamp,
  Timestamp,
  updateDoc,
  writeBatch,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { openDoc, sealDoc } from '../../../shared/crypto'
import {
  EVENT_TYPES,
  MAX_EXTENSION_HOURS,
  MIN_REASON_LENGTH,
  PERMIT_COLLECTION,
  PERMIT_STATUS,
} from '../constants/permits'
import { toMs } from '../utils/permitWindow'
import { canRemoveOwnLock } from '../utils/groupLock'
import {
  applyPermitLocks,
  checksFrom,
  emergencyProblems,
  permitLockNos,
  releasePermitLocks,
  returnProblems,
  startProblems,
} from '../utils/permitLocks'
import { publicBody, publicRef } from './procedures'
import { assertClaimsFree, readClaims, releaseClaims, takeClaims } from './lockClaims'

const permitRef = (orgId, permitNo) => doc(db, 'organizations', orgId, PERMIT_COLLECTION, permitNo)
const eventRef = (orgId, permitNo) =>
  doc(collection(db, 'organizations', orgId, PERMIT_COLLECTION, permitNo, 'events'))
const procRefOf = (id) => doc(db, 'procedures', id)

const clean = (v) => (typeof v === 'string' ? v.trim() : '')

/** One timeline entry. Sealed like the permit: it carries a name and a note. */
function eventBody(orgId, user, type, { note = '', meta = null } = {}) {
  return sealDoc(orgId, `${PERMIT_COLLECTION}/events`, {
    type,
    by: user.id,
    byName: user.displayName || '',
    at: serverTimestamp(),
    ...(clean(note) ? { note: clean(note) } : {}),
    ...(meta ? { meta } : {}),
  })
}

/** The activity-log row (lotoEvents) a lock or unlock has always written. */
function lotoEvent(procedure, permit, point, action, user, extra = {}) {
  return {
    orgId: procedure.orgId,
    procedureId: procedure.id,
    equipment: procedure.equipment || '',
    site: procedure.site || '',
    procedureCode: procedure.procedureCode || '',
    pointKey: point.key,
    pointId: point.pointId || '',
    energy: point.energyLabel || point.energySource || '',
    action,
    techName: point.lockState?.techName || null,
    by: user.id,
    byName: user.displayName,
    at: serverTimestamp(),
    // So the activity log says WHY a point was locked, not just that it was.
    permitNo: permit.id,
    ...extra,
  }
}

async function readHeld(tx, permitId, orgId) {
  const snap = await tx.get(permitRef(orgId, permitId))
  if (!snap.exists()) throw new Error('The permit no longer exists.')
  const raw = { id: snap.id, ...snap.data() }
  let procedure = null
  if ((raw.pointKeys || []).length > 0 && raw.procedureId) {
    const p = await tx.get(procRefOf(raw.procedureId))
    procedure = p.exists() ? { id: p.id, ...p.data() } : null
  }
  return { raw, procedure }
}

const first = (list) => {
  if (list.length) throw new Error(list[0])
}

// ── Decide / withdraw ────────────────────────────────────────────────────────

/**
 * Approve or reject. Admin only (the rules' lotoPermitAdmin()). The approver
 * should not be the requester; when there is no other administrator the
 * approver says so, and that reason is stored with the approval.
 */
export async function decidePermit({ orgId, permit, user, approve, note = '', selfApprovalReason = '' }) {
  const own = permit.requestedBy === user.id
  const namedCrew = (permit.personnelUids || []).includes(user.id) && !own
  if (namedCrew) {
    throw new Error('Someone named on the permit cannot approve it.')
  }
  const reason = clean(selfApprovalReason)
  if (own && approve && !reason) {
    throw new Error('Another administrator must approve your own request.')
  }
  if (!approve && clean(note).length < MIN_REASON_LENGTH) {
    throw new Error(`Say why it is rejected (at least ${MIN_REASON_LENGTH} characters).`)
  }
  const status = approve ? PERMIT_STATUS.APPROVED : PERMIT_STATUS.REJECTED
  const approval = {
    by: user.id,
    byName: user.displayName || '',
    at: serverTimestamp(),
    ...(clean(note) ? { note: clean(note) } : {}),
    ...(own && approve ? { selfApproved: true, selfApprovalReason: reason } : {}),
  }
  const patch = await sealDoc(orgId, PERMIT_COLLECTION, {
    status,
    approval,
    ...(approve ? {} : { closedAt: serverTimestamp() }),
    updatedAt: serverTimestamp(),
  })
  const batch = writeBatch(db)
  batch.update(permitRef(orgId, permit.id), patch)
  batch.set(
    eventRef(orgId, permit.id),
    await eventBody(orgId, user, approve ? EVENT_TYPES.APPROVED : EVENT_TYPES.REJECTED, {
      note,
      meta: own && approve ? { selfApproved: true } : null,
    }),
  )
  await batch.commit()
}

/** An Admin asks for another live photo. Start waits until the new one is later. */
export async function requestNewLockPhoto({ orgId, permit, user, note }) {
  const why = clean(note)
  if (!why) throw new Error('Say what is wrong with the photo.')
  await updateDoc(permitRef(orgId, permit.id), {
    photoRedo: { by: user.id, at: serverTimestamp(), note: why },
    updatedAt: serverTimestamp(),
  })
}

/** A group member takes off only their own lock. The primary closes the permit instead. */
export async function releaseOwnLock({ orgId, permit, user }) {
  const decision = canRemoveOwnLock(permit.groupLock, permit.removedUids || [], user.id)
  if (!decision.ok) throw new Error(decision.reason)
  if (decision.closes) throw new Error('You are the last lock. Return the permit to close it.')
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(permitRef(orgId, permit.id))
    if (!snap.exists()) throw new Error('The permit no longer exists.')
    const raw = snap.data()
    const again = canRemoveOwnLock(raw.groupLock, raw.removedUids || [], user.id)
    if (!again.ok || again.closes) throw new Error(again.reason || 'Return the permit to close it.')
    tx.update(permitRef(orgId, permit.id), {
      removedUids: [...(raw.removedUids || []), user.id],
      updatedAt: serverTimestamp(),
    })
  })
}

/** Withdraw before work starts. The requester or an Admin. */
export async function withdrawPermit({ orgId, permit, user, note = '' }) {
  const patch = await sealDoc(orgId, PERMIT_COLLECTION, {
    status: PERMIT_STATUS.WITHDRAWN,
    closure: {
      by: user.id,
      byName: user.displayName || '',
      at: serverTimestamp(),
      ...(clean(note) ? { note: clean(note) } : {}),
    },
    closedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  const batch = writeBatch(db)
  batch.update(permitRef(orgId, permit.id), patch)
  if (permit.groupLock?.groupNo) {
    batch.update(doc(db, 'organizations', orgId, 'lotoGroupNumbers', permit.groupLock.groupNo), {
      openPermitId: '',
    })
  }
  batch.set(eventRef(orgId, permit.id), await eventBody(orgId, user, EVENT_TYPES.WITHDRAWN, { note }))
  await batch.commit()
}

// ── Start: scans + lock every point + permit active, ONE transaction ─────────

/**
 * `scans` is { [pointKey]: { at: epochMs, method: 'camera' | 'manual' } } — one
 * entry for EVERY isolation point. The camera/manual distinction is kept so an
 * audit can see how many tags were read by hand.
 */
export async function startIsolation({ orgId, permit, scans, user, tryout, lockPhoto }) {
  await runTransaction(db, async (tx) => {
    const { raw, procedure } = await readHeld(tx, permit.id, orgId)
    const lockNos = permitLockNos(raw)
    // Claims are read before any write, for the same reason setPointLock does.
    const held = procedure ? await readClaims(tx, orgId, lockNos) : []

    first(startProblems({ permit: raw, procedure, scans, tryout, lockPhoto, nowMs: Date.now() }))
    if (procedure) assertClaimsFree(held, procedure.id)

    // Names are sealed on the permit; the procedure's lockState holds plain
    // text (the long-standing shape), so the plan is read through openDoc.
    const plan = await openDoc(orgId, PERMIT_COLLECTION, raw)

    const patch = await sealDoc(orgId, PERMIT_COLLECTION, {
      status: PERMIT_STATUS.ACTIVE,
      startedAt: serverTimestamp(),
      isolation: {
        by: user.id,
        at: serverTimestamp(),
        scans: Object.fromEntries(
          Object.entries(scans).map(([k, s]) => [k, { at: s.at, method: s.method, by: user.id }]),
        ),
      },
      tryout: { zeroEnergy: tryout?.zeroEnergy === true, by: user.id, at: serverTimestamp() },
      lockPhoto: {
        path: lockPhoto?.path || '',
        by: user.id,
        byName: user.displayName || '',
        permitNo: raw.permitNo || permit.id,
        equipment: raw.equipment || '',
        at: serverTimestamp(),
        stamped: true,
      },
      updatedAt: serverTimestamp(),
    })
    tx.update(permitRef(orgId, raw.id), patch)

    if (procedure) {
      const atIso = new Date().toISOString()
      const applied = applyPermitLocks(procedure, plan, { user, atIso })
      const update = {
        isolationPoints: applied.points,
        lockSummary: applied.lockSummary,
        primaryTech: applied.primaryTech,
        activePermit: { id: raw.id, permitNo: raw.permitNo || raw.id },
        updatedAt: serverTimestamp(),
      }
      tx.update(procRefOf(procedure.id), update)
      tx.set(publicRef(procedure.id), publicBody({ ...procedure, ...update }))

      for (const l of plan.locks || []) {
        takeClaims(
          tx,
          {
            orgId,
            procedureId: procedure.id,
            procedureCode: procedure.procedureCode,
            equipment: procedure.equipment,
            site: procedure.site,
            holder: 'point',
            pointKey: l.pointKey,
            techId: l.techId || null,
            techName: l.techName || null,
            by: user.id,
            byName: user.displayName,
          },
          [l.lockNo],
        )
      }
      const idOf = new Map((raw.isolationPoints || []).map((p) => [p.key, p.pointId]))
      for (const point of applied.points) {
        tx.set(
          doc(collection(db, 'lotoEvents')),
          lotoEvent(procedure, raw, { ...point, pointId: idOf.get(point.key) || point.pointId }, 'lock', user),
        )
      }
    }
    tx.set(
      eventRef(orgId, raw.id),
      await eventBody(orgId, user, EVENT_TYPES.STARTED, { meta: { points: (raw.pointKeys || []).length } }),
    )
  })
}

// ── Extend ───────────────────────────────────────────────────────────────────

/** Admin only: move the window end later, with a reason. Never earlier. */
export async function extendPermit({ orgId, permit, user, newEndMs, reason }) {
  if (clean(reason).length < MIN_REASON_LENGTH) {
    throw new Error(`Say why more time is needed (at least ${MIN_REASON_LENGTH} characters).`)
  }
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(permitRef(orgId, permit.id))
    if (!snap.exists()) throw new Error('The permit no longer exists.')
    const raw = snap.data()
    if (raw.status !== PERMIT_STATUS.ACTIVE) throw new Error(`This permit is ${raw.status}, not active.`)
    const oldEnd = toMs(raw.windowEnd)
    if (!(newEndMs > oldEnd)) throw new Error('The new end must be later than the current end.')
    if (newEndMs - oldEnd > MAX_EXTENSION_HOURS * 3600 * 1000) {
      throw new Error(`One extension can add at most ${MAX_EXTENSION_HOURS} hours.`)
    }
    // Seal the NEW entry alone and append it to what is stored: the existing
    // entries are already sealed, and sealing them again would double-wrap.
    const sealed = await sealDoc(orgId, PERMIT_COLLECTION, {
      extensions: [
        {
          at: Date.now(),
          by: user.id,
          byName: user.displayName || '',
          from: oldEnd,
          to: newEndMs,
          reason: clean(reason),
        },
      ],
    })
    tx.update(permitRef(orgId, permit.id), {
      windowEnd: Timestamp.fromMillis(newEndMs),
      extensions: [...(raw.extensions || []), ...sealed.extensions],
      updatedAt: serverTimestamp(),
    })
    tx.set(
      eventRef(orgId, permit.id),
      await eventBody(orgId, user, EVENT_TYPES.EXTENDED, { note: reason, meta: { from: oldEnd, to: newEndMs } }),
    )
  })
}

// ── Return / emergency removal: every lock off + permit closed, ONE transaction

async function releaseAndClose({ orgId, permit, user, problems, closing, eventType, note, emergency }) {
  await runTransaction(db, async (tx) => {
    const { raw, procedure } = await readHeld(tx, permit.id, orgId)
    const groupNo = raw.groupLock?.groupNo
    const groupRef = groupNo ? doc(db, 'organizations', orgId, 'lotoGroupNumbers', groupNo) : null
    const groupSnap = groupRef ? await tx.get(groupRef) : null
    first(problems({ raw, procedure }))

    tx.update(permitRef(orgId, raw.id), await closing(raw))
    if (groupSnap && groupSnap.exists()) tx.update(groupRef, { openPermitId: '' })

    if (procedure) {
      const atIso = new Date().toISOString()
      const out = releasePermitLocks(procedure, { user, atIso })
      const update = {
        isolationPoints: out.points,
        lockSummary: out.lockSummary,
        groupLock: out.groupLock,
        primaryTech: null,
        // Cleared in the same commit that closes the permit: the rules accept
        // this only when the permit is returned or emergency-removed.
        activePermit: deleteField(),
        updatedAt: serverTimestamp(),
      }
      tx.update(procRefOf(procedure.id), update)
      // The public mirror describes the equipment as it now is: no marker, no
      // primary technician, nothing locked.
      const { activePermit: _held, ...rest } = procedure
      tx.set(
        publicRef(procedure.id),
        publicBody({
          ...rest,
          isolationPoints: out.points,
          lockSummary: out.lockSummary,
          groupLock: out.groupLock,
          primaryTech: null,
        }),
      )
      // Claims for what actually hung on the equipment AND what the plan named:
      // a delete of an absent claim is a no-op, a missed one strands a padlock.
      releaseClaims(tx, orgId, [...out.released, ...permitLockNos(raw)])
      const idOf = new Map((raw.isolationPoints || []).map((p) => [p.key, p.pointId]))
      for (const point of out.points) {
        const was = (procedure.isolationPoints || []).find((p) => p.key === point.key)
        if (was?.lockState?.locked) {
          tx.set(
            doc(collection(db, 'lotoEvents')),
            lotoEvent(
              procedure,
              raw,
              { ...point, pointId: idOf.get(point.key) || point.pointId, lockState: was.lockState },
              'unlock',
              user,
              emergency ? { emergency: true } : {},
            ),
          )
        }
      }
    }
    tx.set(eventRef(orgId, raw.id), await eventBody(orgId, user, eventType, { note, meta: emergency ? { emergency: true } : null }))
  })
}

/**
 * Return the equipment: the pre-energise checklist ticked, and EACH lock
 * confirmed removed (`confirmed` lists the point keys), then every lock off and
 * the permit returned in one commit.
 */
export async function returnPermit({ orgId, permit, user, ticked, confirmed, note = '' }) {
  await releaseAndClose({
    orgId,
    permit,
    user,
    note,
    eventType: EVENT_TYPES.RETURNED,
    problems: ({ raw, procedure }) => returnProblems({ permit: raw, procedure, ticked, confirmed }),
    closing: async (raw) => {
      const lockFor = new Map((raw.locks || []).map((l) => [l.pointKey, l.lockNo]))
      return sealDoc(orgId, PERMIT_COLLECTION, {
        status: PERMIT_STATUS.RETURNED,
        closure: {
          by: user.id,
          byName: user.displayName || '',
          at: serverTimestamp(),
          ...(clean(note) ? { note: clean(note) } : {}),
        },
        closedAt: serverTimestamp(),
        returnChecks: checksFrom(ticked),
        returns: Object.fromEntries(
          (raw.pointKeys || []).map((k) => [k, { lockNo: lockFor.get(k) || '', by: user.id, at: Date.now() }]),
        ),
        ...(raw.groupLock
          ? { removedUids: [...new Set([...(raw.removedUids || []), user.id])] }
          : {}),
        updatedAt: serverTimestamp(),
      })
    },
  })
}

/**
 * Admin removes the locks without the lock owner: a reason and three
 * attestations are stored with the permit and its timeline.
 */
export async function emergencyRemovePermit({ orgId, permit, user, reason, attest }) {
  await releaseAndClose({
    orgId,
    permit,
    user,
    note: reason,
    emergency: true,
    eventType: EVENT_TYPES.EMERGENCY_REMOVED,
    problems: ({ raw, procedure }) => emergencyProblems({ permit: raw, procedure, reason, attest }),
    closing: async () =>
      sealDoc(orgId, PERMIT_COLLECTION, {
        status: PERMIT_STATUS.EMERGENCY_REMOVED,
        emergency: {
          by: user.id,
          byName: user.displayName || '',
          at: serverTimestamp(),
          reason: clean(reason),
          attest: {
            ownerUnavailable: attest.ownerUnavailable === true,
            equipmentInspected: attest.equipmentInspected === true,
            ownerWillBeTold: attest.ownerWillBeTold === true,
          },
        },
        closedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
  })
}
