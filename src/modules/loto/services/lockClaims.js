// ─────────────────────────────────────────────────────────────────────────────
// One document per padlock currently applied, so the same lock cannot be put on
// two machines at once.
//
// THE DOCUMENT ID IS THE PADLOCK — `${orgId}__${lockNo}`. That is what makes the
// uniqueness real rather than advisory: two operators claiming lock 12 are two
// writes to ONE document, and Firestore serialises those. Neither of the checks
// this backs up could do that, and the gap between them is where the failure
// lived:
//
//   · setPointLock validated the number inside the single procedure document it
//     had already read, so it could see the other points on THIS equipment and
//     nothing about the machine in the next bay;
//   · the operate screen filtered the numbers it offered against
//     collectInUseLockNos(procedures) — a browser-side scan of a list that is
//     itself truncated at COLLECTION_READ_CAP, so a lock held by a procedure
//     past the cap was absent from the in-use set and therefore offered as
//     free.
//
// So two operators both saw #12 available and both committed. In lockout/tagout
// that is not a duplicate reference number: it is a machine one person believes
// their own lock is holding dead while the lock physically on it is somebody
// else's, and the whole control depends on that not being possible.
//
// Claims are taken and released in the SAME transaction as the lock state they
// describe, for the reason the public mirror is: a claim written separately can
// be stranded by a failure between the two writes, and a padlock the system
// insists is in use but nobody can find is how people learn to work around the
// system.
//
// The rules block for this collection (`firestore.rules`, /lockClaims) is the
// other half. `resource == null` on create is the guarantee — without it a
// second claimant's create succeeds by overwriting the first — and the id
// prefix is pinned to the payload's org so a stranger cannot take out a claim
// at another tenant's address and make a padlock permanently unusable there.
// ─────────────────────────────────────────────────────────────────────────────
import { collection, doc, getDoc, getDocs, limit, query, serverTimestamp, where, writeBatch } from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { COLLECTION_READ_CAP } from '../../../shared/org/orgData'

export const CLAIMS_COL = 'lockClaims'

/**
 * The claim id for a padlock.
 *
 * encodeURIComponent because a lock number is typed by a person and Firestore
 * refuses a '/' in a document id — a technician entering "12/A" would otherwise
 * crash the lock instead of taking it. Ordinary numbers and codes pass through
 * unchanged, which keeps the id readable to whoever is reading the database
 * after an incident.
 *
 * The '__' separator survives it: the rules compare only the FIRST segment
 * against the payload's orgId, and an orgId is a Firestore auto-id
 * ([A-Za-z0-9]{20}) that can never contain one.
 */
export function claimId(orgId, lockNo) {
  return `${orgId}__${encodeURIComponent(String(lockNo))}`
}

export function claimRef(orgId, lockNo) {
  return doc(db, CLAIMS_COL, claimId(orgId, lockNo))
}

/**
 * Unique, non-empty lock numbers as strings.
 *
 * Callers hand this a mixture: one number, a map of point → number, a group
 * member's box lock that may be absent. Normalising in one place is what stops
 * a claim being taken under '12' and looked for under 12.
 */
export function normaliseLockNos(values) {
  const out = []
  for (const v of values || []) {
    if (v === null || v === undefined || v === '') continue
    const s = String(v)
    if (!out.includes(s)) out.push(s)
  }
  return out
}

/**
 * Read the claims for `lockNos` inside a transaction.
 *
 * MUST be called before the transaction's first write — Firestore refuses a
 * read after a write, and every caller here reads its procedure first and then
 * these. Sequential rather than parallel: the counts are one to a handful, and
 * a loop is one less thing to be clever about inside the only transaction in
 * this app whose failure mode is physical.
 */
export async function readClaims(tx, orgId, lockNos) {
  const held = []
  for (const lockNo of normaliseLockNos(lockNos)) {
    const snap = await tx.get(claimRef(orgId, lockNo))
    held.push({ lockNo, exists: snap.exists(), data: snap.exists() ? snap.data() : null })
  }
  return held
}

/**
 * The claims in `held` that belong to somebody else.
 *
 * A claim already held by THIS procedure is not a conflict: re-asserting one is
 * how a personal→department swap lands, and the rules permit that update
 * precisely because the holder has not changed.
 *
 * Pure, so the refusal can be tested without an emulator — which matters,
 * because the emulator suite proves the rule and this proves the message the
 * person at the machine actually reads.
 */
export function conflicts(held, procedureId) {
  return (held || []).filter((h) => h.exists && h.data?.procedureId !== procedureId)
}

/**
 * Why the lock was refused, in words that name the other machine.
 *
 * "Lock 12 is already in use" was the old message and it sent people to look at
 * the equipment in front of them, which is the one place the lock is not. The
 * claim knows where it is; saying so is most of the value of having one.
 */
export function conflictMessage(conflict) {
  const where = conflict?.data?.equipment || conflict?.data?.procedureCode
  return where
    ? `Lock ${conflict.lockNo} is already applied on ${where}. Use another lock.`
    : `Lock ${conflict.lockNo} is already applied on other equipment. Use another lock.`
}

/** Refuse the whole write if any of these padlocks is somewhere else. */
export function assertClaimsFree(held, procedureId) {
  const clash = conflicts(held, procedureId)
  if (clash.length) throw new Error(conflictMessage(clash[0]))
}

/**
 * Claim `lockNos` for this procedure.
 *
 * `set` rather than `create`: the rules accept a create only when no claim
 * exists and an update only when the org and procedure are unchanged, so a set
 * that would take a live claim off another procedure is refused by the database
 * — the guarantee does not depend on this function checking first.
 * assertClaimsFree runs anyway, because a permission-denied tells the person at
 * the machine nothing about which lock or where it is.
 */
export function takeClaims(writer, context, lockNos) {
  const { orgId, procedureId } = context
  for (const lockNo of normaliseLockNos(lockNos)) {
    writer.set(claimRef(orgId, lockNo), {
      orgId,
      lockNo,
      procedureId,
      procedureCode: context.procedureCode || '',
      equipment: context.equipment || '',
      site: context.site || '',
      holder: context.holder || 'point',
      pointKey: context.pointKey || null,
      techId: context.techId || null,
      techName: context.techName || null,
      by: context.by || null,
      byName: context.byName || null,
      at: serverTimestamp(),
    })
  }
}

/**
 * Release `lockNos`.
 *
 * A blind delete, and deliberately: the claim being absent is the normal state
 * for a padlock applied before this collection existed, and refusing to release
 * a physical lock because its bookkeeping is missing would be the failure this
 * whole file is trying to prevent, pointed the other way.
 */
export function releaseClaims(writer, orgId, lockNos) {
  for (const lockNo of normaliseLockNos(lockNos)) {
    writer.delete(claimRef(orgId, lockNo))
  }
}

/**
 * Every padlock a procedure currently holds — point locks and group locks both.
 *
 * Used to release them all when a procedure is deleted, and by the backfill
 * below. Reads the procedure's own state rather than the claims, because the
 * procedure is the record of what is physically on the equipment.
 */
export function lockNosHeldBy(procedure) {
  const nos = []
  for (const p of procedure?.isolationPoints || []) {
    if (p?.lockState?.locked && p.lockState.techLockNo) nos.push(p.lockState.techLockNo)
  }
  for (const m of procedure?.groupLock?.members || []) {
    if (m?.boxLock) nos.push(m.boxLock)
    for (const no of Object.values(m?.locks || {})) if (no) nos.push(no)
  }
  return normaliseLockNos(nos)
}

/**
 * Register the padlocks that were already on equipment when this collection
 * arrived.
 *
 * Without it there is a hole with a clock in it: closing the write path closes
 * nothing already applied. A lock hanging on a machine since before the deploy
 * has no claim, so the number reads as free and the next operator can take it
 * for a different machine — the exact state the collection exists to prevent,
 * surviving for as long as the oldest live lockout, which on a plant shutdown
 * is weeks.
 *
 * Idempotent, and it never takes a claim from a live holder: a number already
 * claimed by another procedure is REPORTED as a conflict rather than
 * overwritten. Two procedures both believing they hold lock 12 is a real
 * disagreement about the physical world, and the right thing to do with it is
 * put it in front of a person, not pick a winner.
 *
 * `dryRun` reports without writing, because the honest thing before a bulk
 * write is to say what it will touch.
 */
export async function backfillLockClaims(orgId, { dryRun = true, max = COLLECTION_READ_CAP } = {}) {
  const snap = await getDocs(
    query(collection(db, 'procedures'), where('orgId', '==', orgId), limit(max)),
  )
  const procedures = snap.docs.map((d) => ({ id: d.id, ...d.data() }))

  const wanted = []
  for (const p of procedures) {
    for (const lockNo of lockNosHeldBy(p)) {
      wanted.push({ lockNo, procedure: p })
    }
  }

  let present = 0
  const missing = []
  const clashes = []
  for (const w of wanted) {
    const existing = await getDoc(claimRef(orgId, w.lockNo))
    if (!existing.exists()) missing.push(w)
    else if (existing.data()?.procedureId === w.procedure.id) present += 1
    else clashes.push(`${w.lockNo} — claimed by ${existing.data()?.equipment || existing.data()?.procedureId}, also recorded on ${w.procedure.equipment || w.procedure.id}`)
  }

  const result = {
    total: wanted.length,
    present,
    missing: missing.length,
    clashes,
    ids: missing.slice(0, 20).map((m) => `${m.lockNo} — ${m.procedure.equipment || m.procedure.id}`),
  }
  if (dryRun) return { ...result, written: 0 }

  // Firestore caps a batch at 500 operations.
  let written = 0
  for (let i = 0; i < missing.length; i += 400) {
    const batch = writeBatch(db)
    for (const m of missing.slice(i, i + 400)) {
      const point = (m.procedure.isolationPoints || []).find(
        (p) => p?.lockState?.locked && String(p.lockState.techLockNo) === m.lockNo,
      )
      takeClaims(
        batch,
        {
          orgId,
          procedureId: m.procedure.id,
          procedureCode: m.procedure.procedureCode,
          equipment: m.procedure.equipment,
          site: m.procedure.site,
          holder: point ? 'point' : 'group',
          pointKey: point?.key || null,
          techId: point?.lockState?.techId || null,
          techName: point?.lockState?.techName || null,
        },
        [m.lockNo],
      )
      written += 1
    }
    await batch.commit()
  }
  return { ...result, written }
}
