// ─────────────────────────────────────────────────────────────────────────────
// Sam's live data — cheap Firestore COUNT aggregations (no document reads, so
// this stays fast and cheap even at 5 000-employee scale). Cached for 60 s.
// ─────────────────────────────────────────────────────────────────────────────
import { collection, query, where, getCountFromServer } from '../data/client.js'
import { db } from '../db'

const TTL_MS = 60_000
const cache = new Map() // orgId → { at, stats }

const orgCol = (orgId, name) => collection(db, 'organizations', orgId, name)

async function count(ref) {
  try {
    const snap = await getCountFromServer(ref)
    return snap.data().count
  } catch {
    return undefined // rules/read failures just omit the stat
  }
}

/** Counts across the modules Sam talks about. Missing keys = unavailable. */
export async function getStats(orgId) {
  const hit = cache.get(orgId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.stats

  const jobs = {
    incidents: count(orgCol(orgId, 'incidents')),
    illnesses: count(orgCol(orgId, 'illnesses')),
    assessments: count(orgCol(orgId, 'assessments')),
    auditFindings: count(orgCol(orgId, 'auditFindings')),
    auditPlans: count(orgCol(orgId, 'auditPlans')),
    inspectionRecords: count(orgCol(orgId, 'inspectionRecords')),
    permits: count(orgCol(orgId, 'permits')),
    consultations: count(orgCol(orgId, 'consultations')),
    mockDrills: count(orgCol(orgId, 'mockDrills')),
    extinguishers: count(orgCol(orgId, 'extinguishers')),
    erpContacts: count(orgCol(orgId, 'erpContacts')),
    erpRescuePlans: count(orgCol(orgId, 'erpRescuePlans')),
    trainingCourses: count(orgCol(orgId, 'trainingCourses')),
    trainingRecords: count(orgCol(orgId, 'trainingRecords')),
    trainingAssignments: count(orgCol(orgId, 'trainingAssignments')),
    documents: count(orgCol(orgId, 'documents')),
    sites: count(orgCol(orgId, 'sites')),
    users: count(query(collection(db, 'users'), where('orgId', '==', orgId))),
    lotoProcedures: count(query(collection(db, 'procedures'), where('orgId', '==', orgId))),
  }

  const entries = await Promise.all(
    Object.entries(jobs).map(async ([k, p]) => [k, await p]),
  )
  const stats = Object.fromEntries(entries.filter(([, v]) => typeof v === 'number'))
  cache.set(orgId, { at: Date.now(), stats })
  return stats
}
