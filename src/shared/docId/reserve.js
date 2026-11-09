// ─────────────────────────────────────────────────────────────────────────────
// Issuing the next document id.
//
// The counter lives in one document per org, `meta/docSeq`, with a field per
// kind. One document rather than one per kind because a transaction reads it
// once, and because the backfill and the admin screen both want the whole set.
//
// Reserving is a transaction, not a read-then-write. Two people raising a
// permit in the same second is ordinary, and the failure it would otherwise
// cause is two permits sharing a number — which is the one thing an identifier
// may not do, and which nothing downstream would detect.
//
// Numbers are consumed even when the record that asked for one fails to save.
// That is deliberate: a gap in the sequence is harmless, and the alternative —
// handing the same number out twice — is not.
// ─────────────────────────────────────────────────────────────────────────────
import { collection, doc, getDoc, getDocs, runTransaction, setDoc } from '../data/client.js'
import { db } from '../db'
import { formatDocId, deriveOrgCode, normalizeOrgCode } from './format'

// One document per kind holding a single integer `n`, at
// organizations/{orgId}/docSeq/{kind}.
//
// It used to be ONE document with a field per kind. That shape could not be
// secured: security rules cannot compare a dynamically-named field, so the
// counter fell under the generic member rule and any approved member could set
// it backwards — handing the next record an id already printed on a permit.
// Split per kind, the rule becomes `n > resource.data.n`, which is checkable.
const seqRef = (orgId, kind) => doc(db, 'organizations', orgId, 'docSeq', kind)
const seqCol = (orgId) => collection(db, 'organizations', orgId, 'docSeq')
// The pre-split counter. Read once per kind to seed the new document, so
// existing orgs migrate on first use with no script and no downtime.
const legacySeqRef = (orgId) => doc(db, 'organizations', orgId, 'meta', 'docSeq')
const orgRef = (orgId) => doc(db, 'organizations', orgId)

// The org code changes about never, and every create would otherwise read the
// org document to learn it.
const codeCache = new Map()

/** Forget cached codes — used after an admin edits one, and by tests. */
export function _clearOrgCodeCache() {
  codeCache.clear()
  legacyCache.clear()
}

/**
 * The org's short code, from its `docCode` field, derived from its name if it
 * has never been set. Deriving rather than refusing means an org that predates
 * this gets sensible ids without an admin having to do anything first.
 */
export async function getOrgCode(orgId) {
  if (!orgId) return 'ORG'
  if (codeCache.has(orgId)) return codeCache.get(orgId)
  let code = 'ORG'
  try {
    const snap = await getDoc(orgRef(orgId))
    const data = snap.exists() ? snap.data() : {}
    code = normalizeOrgCode(data.docCode) || deriveOrgCode(data.name)
  } catch {
    // A create must not fail because the org document could not be read; the
    // fallback still produces a unique, well-formed id.
  }
  codeCache.set(orgId, code)
  return code
}

/** Set the org's code explicitly. Returns the normalised value actually stored. */
export async function setOrgCode(orgId, value) {
  const code = normalizeOrgCode(value)
  if (!code) throw new Error('A document code needs 2–5 letters or digits')
  await setDoc(orgRef(orgId), { docCode: code }, { merge: true })
  codeCache.set(orgId, code)
  return code
}

/**
 * Reserve the next id for a kind. Safe against concurrent callers.
 *
 * @param floor optional lowest acceptable number, used by the backfill so that
 *              ids issued after it continue past what it assigned.
 */
export async function reserveDocId(orgId, kind, { orgCode, floor = 0 } = {}) {
  const code = orgCode || (await getOrgCode(orgId))
  const seq = await reserveSeq(orgId, kind, { floor })
  return formatDocId(kind, code, seq)
}

/**
 * Reserve `count` document references at once.
 *
 * One transaction for the whole block rather than one per row. A CSV import of
 * two hundred risk assessments through reserveDocId would be two hundred
 * transactions against the same counter document, each retrying against the
 * last — slow enough to look broken, and contended enough to sometimes be.
 */
export async function reserveDocIds(orgId, kind, count, { orgCode } = {}) {
  const n = Math.max(0, Math.floor(count))
  if (!n) return []
  const code = orgCode || (await getOrgCode(orgId))
  const first = await reserveSeq(orgId, kind, { count: n })
  return Array.from({ length: n }, (_, i) => formatDocId(kind, code, first + i))
}

/**
 * Reserve the next `count` numbers for a kind and return the FIRST of them.
 *
 * The same transaction reserveDocId is built on, without the MODULE-ORG_0001
 * formatting — for identifiers that have their own established shape and are
 * printed on physical things. An AED carries `AED-0042` on a QR label; giving
 * it a document reference as well would be two answers to "which unit is this",
 * which is why DOC_CODES deliberately has no equipment entries.
 *
 * `count` exists for the generate-for-every-site buttons, which need a block of
 * numbers nobody else can be inside. Reserving them one at a time would leave
 * another operator's asset interleaved through the batch.
 *
 * @param floor lowest acceptable number. The asset registers pass their current
 *              highest, which is what seeds a counter that starts at zero
 *              against a register full of assets numbered before it existed.
 */
export async function reserveSeq(orgId, kind, { count = 1, floor = 0 } = {}) {
  // Read the legacy counter OUTSIDE the transaction: a transaction may retry,
  // and this is a one-time migration read whose value cannot change (nothing
  // writes the old document any more).
  const legacyFloor = await legacyCounterFor(orgId, kind)
  const n = Math.max(1, Math.floor(count))
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(seqRef(orgId, kind))
    const current = (snap.exists() && Number(snap.data().n)) || 0
    const first = Math.max(current, legacyFloor, floor) + 1
    // Not merge: the document holds exactly { n }, which is what the rule pins.
    tx.set(seqRef(orgId, kind), { n: first + n - 1 })
    return first
  })
}

// Legacy per-org counter values, fetched once per org and cached. Returns 0
// once an org has no pre-split counter, which is every org created from here on.
const legacyCache = new Map()
async function legacyCounterFor(orgId, kind) {
  if (!legacyCache.has(orgId)) {
    legacyCache.set(orgId, getDoc(legacySeqRef(orgId))
      .then((s) => (s.exists() ? s.data() : {}))
      .catch(() => ({})))
  }
  const data = await legacyCache.get(orgId)
  return Number(data?.[kind]) || 0
}

/**
 * Every counter for an org, for the admin screen. Merges the per-kind
 * documents over the legacy one so a partially-migrated org reports the true
 * high-water mark for every kind, not just the ones reserved since the split.
 */
export async function readCounters(orgId) {
  const [legacy, snap] = await Promise.all([
    getDoc(legacySeqRef(orgId)).then((s) => (s.exists() ? s.data() : {})).catch(() => ({})),
    getDocs(seqCol(orgId)).catch(() => ({ docs: [] })),
  ])
  const out = { ...legacy }
  for (const d of snap.docs) {
    const n = Number(d.data().n) || 0
    if (n > (Number(out[d.id]) || 0)) out[d.id] = n
  }
  return out
}

/**
 * Move a counter forward, never back.
 *
 * The backfill calls this after numbering existing records. Clamping upward is
 * what stops a re-run — or a stale browser tab — from rewinding the counter and
 * handing out numbers that are already on documents.
 */
export async function raiseCounter(orgId, kind, to) {
  const legacyFloor = await legacyCounterFor(orgId, kind)
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(seqRef(orgId, kind))
    const current = Math.max((snap.exists() && Number(snap.data().n)) || 0, legacyFloor)
    // The rule refuses a write that does not increase, so guarding here is not
    // only an optimisation — an equal write would be rejected outright.
    if (to > current) tx.set(seqRef(orgId, kind), { n: to })
  })
}
