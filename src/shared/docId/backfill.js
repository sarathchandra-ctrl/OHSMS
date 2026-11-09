// ─────────────────────────────────────────────────────────────────────────────
// Giving existing records their document ids.
//
// Numbering only new records would leave a permanent hole: every incident
// raised before today would have no id, in a system whose whole point is that
// every document has one. So existing records are numbered too, oldest first,
// which is the order they would have been issued in had this always existed.
//
// Two properties matter more than speed here.
//
// It is re-runnable. Records that already have an id are skipped, not
// renumbered, so a run interrupted halfway can simply be run again. An id, once
// issued, is on paper somewhere and cannot change.
//
// It never rewinds a counter. Numbering finishes by raising the live counter to
// the highest it assigned, so ids handed out afterwards continue past the
// backfill rather than colliding with it.
// ─────────────────────────────────────────────────────────────────────────────
import { collection, getDocs, writeBatch, doc } from '../data/client.js'
import { db } from '../db'
import { formatDocId, highestSeq, parseDocId } from './format'
import { getOrgCode, raiseCounter, readCounters } from './reserve'

/**
 * Which collection holds each kind.
 *
 * LOTO procedures are absent on purpose: they live in a top-level `procedures`
 * collection with no org field, so there is no safe way to number one org's
 * without reading another's. That is a tenancy question to settle before it can
 * join this list.
 */
export const DOC_COLLECTIONS = {
  incidents: 'incidents',
  illnesses: 'illnesses',
  hira: 'assessments',
  inspections: 'inspectionRecords',
  audit: 'auditPlans',
  auditFindings: 'auditFindings',
  ptw: 'permits',
  observations: 'observations',
  drills: 'mockDrills',
  committee: 'consultations',
  training: 'trainingCourses',
  trainingSessions: 'trainingSessions',
  documents: 'documents',
  emergency: 'erpRescuePlans',
  objectives: 'objectives',
}

export const BACKFILL_KINDS = Object.keys(DOC_COLLECTIONS)

/** Firestore caps a batch at 500 writes. */
const BATCH_LIMIT = 400

const millis = (v) => {
  if (!v) return 0
  if (typeof v.toMillis === 'function') return v.toMillis()
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : 0
}

/**
 * Number one kind for one org.
 *
 * @returns { kind, total, assigned, skipped, from, to }
 */
export async function backfillKind(kind, { orgCode } = {}) {
  const collectionName = DOC_COLLECTIONS[kind]
  if (!collectionName) throw new Error(`No collection mapped for "${kind}"`)

  const code = orgCode || (await getOrgCode())
  const snap = await getDocs(collection(db, collectionName))
  const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() }))

  // "Already numbered" means numbered in *this* scheme. Mock drills carried a
  // docId of their own (MD-SITE-48213, with a random suffix), and treating any
  // non-empty value as done would have left one module permanently outside the
  // format this exists to impose. Whatever was there is kept as legacyDocId, so
  // an id already printed on a drill report can still be looked up.
  const already = rows.filter((r) => parseDocId(r.data.docId))
  const missing = rows.filter((r) => !parseDocId(r.data.docId))

  // Continue past both the live counter and anything already issued, so a
  // partially-numbered collection cannot produce a duplicate.
  const counters = await readCounters()
  let seq = Math.max(
    Number(counters[kind]) || 0,
    highestSeq(already.map((r) => r.data.docId))
  )
  const from = seq + 1

  // Oldest first: the order they would have been numbered in all along.
  missing.sort((a, b) => millis(a.data.createdAt) - millis(b.data.createdAt))

  for (let i = 0; i < missing.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db)
    for (const row of missing.slice(i, i + BATCH_LIMIT)) {
      seq += 1
      const update = { docId: formatDocId(kind, code, seq) }
      // Only when there was a real id to displace, and only once — a re-run
      // must not overwrite the original legacy value with a generated one.
      if (row.data.docId && !row.data.legacyDocId) update.legacyDocId = row.data.docId
      batch.update(doc(db, collectionName, row.id), update)
    }
    await batch.commit()
  }

  if (seq > 0) await raiseCounter(kind, seq)

  return {
    kind,
    total: rows.length,
    assigned: missing.length,
    skipped: already.length,
    from: missing.length ? from : null,
    to: missing.length ? seq : null,
  }
}

/**
 * Number everything. Kinds run one after another rather than at once: this is a
 * one-off an admin watches, and a burst of parallel collection scans is a good
 * way to be rate-limited partway through.
 *
 * A kind that fails is reported and does not stop the others — a missing
 * collection or a rules gap on one module should not block the other fourteen.
 */
export async function backfillAll({ onProgress } = {}) {
  const orgCode = await getOrgCode()
  const results = []
  for (const kind of BACKFILL_KINDS) {
    try {
      const r = await backfillKind(kind, { orgCode })
      results.push(r)
      onProgress?.(r)
    } catch (e) {
      const r = { kind, total: 0, assigned: 0, skipped: 0, error: e?.message || 'Failed' }
      results.push(r)
      onProgress?.(r)
    }
  }
  return results
}
