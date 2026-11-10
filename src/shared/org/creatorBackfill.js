// ─────────────────────────────────────────────────────────────────────────────
// Give older records the creator uid the access rules now read.
//
// stack/policy.mjs lets an employee edit a record they created, and decides
// that from a uid on the row (createdBy / createdByUid). Committee meetings
// and inspection records stored only the creator's NAME — the meeting's
// `createdBy` is a name or email, an inspection's is a name — so every one
// saved before createdByUid existed can now be edited only by a manager,
// including by the person who wrote it.
//
// This matches each name to a person and writes `createdByUid`. A match must
// be unique: two people with the same name is a guess, and a guess here hands
// one of them edit rights over the other's minutes. Those are reported, not
// written; a manager can still edit them.
//
// The policy deliberately does NOT compare names itself. A person may change
// their own display name, so a name rule would let anyone become anyone's
// author by renaming themselves.
// ─────────────────────────────────────────────────────────────────────────────
import { collection, doc, getDocs, limit, query, writeBatch } from '../data/client.js'
import { db } from '../db'
import { openDocs } from '../crypto'
import { COLLECTION_READ_CAP } from './orgData'

// `from` reads the name a record holds; `to` is the uid field to write.
// Audit findings name two people: the auditor who raised them (who may edit
// them as their creator) and the auditee assigned to answer them.
export const CREATOR_COLLECTIONS = [
  // Minutes are sealed, createdBy included, so they are opened first.
  { name: 'consultations', label: 'Committee meetings', sealed: true, from: (r) => r.createdBy, to: 'createdByUid' },
  { name: 'inspectionRecords', label: 'Inspection records', sealed: false, from: (r) => r.createdBy, to: 'createdByUid' },
  { name: 'auditFindings', label: 'Audit findings (auditor)', sealed: false, from: (r) => r.auditor, to: 'createdByUid' },
  { name: 'auditFindings', label: 'Audit findings (auditee)', sealed: false, from: (r) => r.taskDetails?.auditee, to: 'auditeeUid' },
]

const norm = (v) => String(v ?? '').trim().toLowerCase()

/**
 * Pure: which rows can be given a creator uid, and which cannot.
 *
 * `rows` are { id, createdBy, createdByUid? }; `users` are { uid, name, email }.
 * Rows that already carry createdByUid are skipped. A name or email that
 * belongs to more than one person is ambiguous; one that belongs to nobody
 * (a person since removed, or free text) is unmatched.
 */
export function matchCreators(rows = [], users = [], { from = (r) => r?.createdBy, to = 'createdByUid' } = {}) {
  const byKey = new Map()
  for (const u of users) {
    if (!u?.uid) continue
    for (const key of new Set([norm(u.name), norm(u.email)])) {
      if (!key) continue
      if (!byKey.has(key)) byKey.set(key, new Set())
      byKey.get(key).add(u.uid)
    }
  }
  const matched = []
  const ambiguous = []
  const unmatched = []
  let already = 0
  for (const r of rows) {
    if (r?.[to]) {
      already += 1
      continue
    }
    const name = from(r)
    const key = norm(name)
    const uids = key ? byKey.get(key) : null
    if (!uids || uids.size === 0) unmatched.push(name || '(no name)')
    else if (uids.size > 1) ambiguous.push(name)
    else matched.push({ id: r.id, uid: [...uids][0] })
  }
  return { matched, ambiguous, unmatched, already }
}

/**
 * Check first (dryRun), then write. Returns one summary per collection.
 * Runs as the signed-in administrator, under the same rules as any edit.
 */
export async function backfillCreatorUids({ dryRun = true } = {}) {
  const usersSnap = await getDocs(query(collection(db, 'users'), limit(COLLECTION_READ_CAP)))
  const users = usersSnap.docs.map((d) => ({ uid: d.id, ...d.data() }))
  const out = []
  for (const c of CREATOR_COLLECTIONS) {
    const snap = await getDocs(query(collection(db, c.name), limit(COLLECTION_READ_CAP)))
    const raw = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    const rows = c.sealed ? await openDocs(c.name, raw) : raw
    const result = matchCreators(rows, users, { from: c.from, to: c.to })
    let written = 0
    if (!dryRun) {
      for (let i = 0; i < result.matched.length; i += 400) {
        const batch = writeBatch(db)
        for (const m of result.matched.slice(i, i + 400)) {
          batch.update(doc(db, c.name, m.id), { [c.to]: m.uid })
        }
        await batch.commit()
        written += Math.min(400, result.matched.length - i)
      }
    }
    out.push({ ...c, ...result, written })
  }
  return out
}
