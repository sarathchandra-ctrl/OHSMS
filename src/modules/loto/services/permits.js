// ─────────────────────────────────────────────────────────────────────────────
// Reading and raising LOTO permits (organizations/{orgId}/lotoPermits).
//
// Raising is ONE transaction: the year's counter is read and bumped, the permit
// is created under that number, and any padlock the requester registered inline
// is created in the register. firestore.rules require the counter bump to be in
// the same commit as the permit (getAfter), so a number cannot be chosen,
// reused or skipped by a client that does not go through here.
//
// Moving a permit on — approve, start, extend, return — is permitActions.js.
// ─────────────────────────────────────────────────────────────────────────────
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { COLLECTION_READ_CAP } from '../../../shared/org/orgData'
import { openDoc, openSnapshots, sealDoc } from '../../../shared/crypto'
import { PERMIT_COLLECTION, PERMIT_STATUS } from '../constants/permits'
import { formatPermitNo, permitSeqKind, permitYearNow } from '../utils/permitNumber'
import { toMs } from '../utils/permitWindow'
import { assertClaimsFree, readClaims } from './lockClaims'

const permitsCol = (orgId) => collection(db, 'organizations', orgId, PERMIT_COLLECTION)
const permitRef = (orgId, permitNo) => doc(db, 'organizations', orgId, PERMIT_COLLECTION, permitNo)
const seqRef = (orgId, year) => doc(db, 'organizations', orgId, 'docSeq', permitSeqKind(year))

/** Newest first. Capped like every other list: it grows for as long as the org does. */
export function subscribePermits(orgId, cb, onError) {
  if (!orgId) return () => {}
  const opened = openSnapshots(orgId, PERMIT_COLLECTION, cb)
  return onSnapshot(
    query(permitsCol(orgId), orderBy('requestedAt', 'desc'), limit(COLLECTION_READ_CAP)),
    (snap) => opened(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError,
  )
}

/** One permit, live. `cb(null)` when it does not exist (or was purged). */
export function subscribePermit(orgId, permitNo, cb, onError) {
  if (!orgId || !permitNo) return () => {}
  let latest = 0
  return onSnapshot(
    permitRef(orgId, permitNo),
    async (snap) => {
      const mine = ++latest
      const row = snap.exists() ? await openDoc(orgId, PERMIT_COLLECTION, { id: snap.id, ...snap.data() }) : null
      // Decryption is async: drop a result that a newer snapshot has overtaken.
      if (mine === latest) cb(row)
    },
    onError,
  )
}

/**
 * The fields rules accept on create, in the shape the document is stored:
 * epoch ms become Timestamps and `permit.windowStartMs/EndMs` go away.
 */
export function toStoredPermit(permit, { permitNo, permitSeq, now = () => serverTimestamp() }) {
  const { windowStartMs, windowEndMs, ...rest } = permit
  return {
    ...rest,
    permitNo,
    permitSeq,
    status: PERMIT_STATUS.REQUESTED,
    windowStart: Timestamp.fromMillis(windowStartMs),
    windowEnd: Timestamp.fromMillis(windowEndMs),
    requestedAt: now(),
    updatedAt: now(),
  }
}

/** The register entry for a padlock the requester typed in while raising the permit. */
export function inlineLockDoc({ orgId, lockNo }, user, now = () => serverTimestamp()) {
  return {
    orgId,
    lockNo: String(lockNo).trim(),
    // Registered inline = a shared department padlock. A personal lock belongs
    // to a technician and is added on the Technicians screen, not on the fly.
    type: 'department',
    active: true,
    createdBy: user.id,
    createdAt: now(),
  }
}

/**
 * Raise a permit.
 *
 * `permit` is buildPermit()'s output. `inlineLocks` lists lock numbers that are
 * not yet in the register and are to be added with it. Returns the permit number.
 *
 * The global padlock check (lockClaims) is read here too, so a lock that is
 * already on another machine is refused at the request — not three steps later
 * at the machine. It is checked again, and enforced by the database, when the
 * locks are actually taken (permitActions.startIsolation).
 */
export async function createPermit({ orgId, user, permit, inlineLocks = [] }) {
  if (!orgId || !user?.id) throw new Error('Not signed in to an organization')
  const year = permitYearNow()
  const permitNo = await runTransaction(db, async (tx) => {
    // Reads first: Firestore refuses a read after a write.
    const counter = await tx.get(seqRef(orgId, year))
    const held = await readClaims(
      tx,
      orgId,
      permit.locks.map((l) => l.lockNo),
    )
    const groupNo = permit.groupLock?.groupNo
    const groupDoc = groupNo
      ? await tx.get(doc(db, 'organizations', orgId, 'lotoGroupNumbers', groupNo))
      : null
    if (groupNo && (!groupDoc.exists() || groupDoc.data()?.openPermitId)) {
      throw new Error('That group lockout number is not free.')
    }
    assertClaimsFree(held, permit.procedureId)
    const seq = (counter.exists() ? Number(counter.data().n) || 0 : 0) + 1
    const number = formatPermitNo(year, seq)
    tx.set(seqRef(orgId, year), { n: seq })
    tx.set(permitRef(orgId, number), await sealDoc(orgId, PERMIT_COLLECTION, toStoredPermit(permit, { permitNo: number, permitSeq: seq })))
    if (groupNo) tx.update(doc(db, 'organizations', orgId, 'lotoGroupNumbers', groupNo), { openPermitId: number })
    for (const lockNo of inlineLocks) {
      tx.set(doc(collection(db, 'locks')), inlineLockDoc({ orgId, lockNo }, user))
    }
    return number
  })
  return permitNo
}

/** The permit's timeline, oldest first. Opened: it carries names and notes. */
export function subscribePermitEvents(orgId, permitNo, cb, onError) {
  if (!orgId || !permitNo) return () => {}
  const col = collection(db, 'organizations', orgId, PERMIT_COLLECTION, permitNo, 'events')
  const opened = openSnapshots(orgId, `${PERMIT_COLLECTION}/events`, (rows) =>
    cb(rows.sort((a, b) => (toMs(a.at) || 0) - (toMs(b.at) || 0))),
  )
  return onSnapshot(
    query(col, limit(COLLECTION_READ_CAP)),
    (snap) => opened(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError,
  )
}
