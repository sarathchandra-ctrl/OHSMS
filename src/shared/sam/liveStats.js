// ─────────────────────────────────────────────────────────────────────────────
// Sam's live data — cheap Firestore COUNT aggregations (no document reads, so
// this stays fast and cheap even at 5 000-employee scale). Cached for 60 s.
// ─────────────────────────────────────────────────────────────────────────────
import { collection, query, where, getCountFromServer } from '../data/client.js'
import { db } from '../db'

const TTL_MS = 60_000
const cache = new Map() // 'org' → { at, stats }

const orgCol = (name) => collection(db, name)

async function count(ref) {
  try {
    const snap = await getCountFromServer(ref)
    return snap.data().count
  } catch {
    return undefined // rules/read failures just omit the stat
  }
}

/** Counts across the modules Sam talks about. Missing keys = unavailable. */
export async function getStats() {
  const hit = cache.get('org')
  if (hit && Date.now() - hit.at < TTL_MS) return hit.stats

  const jobs = {
    incidents: count(orgCol('incidents')),
    illnesses: count(orgCol('illnesses')),
    assessments: count(orgCol('assessments')),
    auditFindings: count(orgCol('auditFindings')),
    auditPlans: count(orgCol('auditPlans')),
    inspectionRecords: count(orgCol('inspectionRecords')),
    permits: count(orgCol('permits')),
    consultations: count(orgCol('consultations')),
    mockDrills: count(orgCol('mockDrills')),
    extinguishers: count(orgCol('extinguishers')),
    erpContacts: count(orgCol('erpContacts')),
    erpRescuePlans: count(orgCol('erpRescuePlans')),
    trainingCourses: count(orgCol('trainingCourses')),
    trainingRecords: count(orgCol('trainingRecords')),
    trainingAssignments: count(orgCol('trainingAssignments')),
    documents: count(orgCol('documents')),
    sites: count(orgCol('sites')),
    users: count(query(collection(db, 'users'))),
    lotoProcedures: count(query(collection(db, 'procedures'))),
  }

  const entries = await Promise.all(
    Object.entries(jobs).map(async ([k, p]) => [k, await p]),
  )
  const stats = Object.fromEntries(entries.filter(([, v]) => typeof v === 'number'))
  cache.set('org', { at: Date.now(), stats })
  return stats
}
