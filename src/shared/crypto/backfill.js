// ─────────────────────────────────────────────────────────────────────────────
// Sealing what is already stored.
//
// Turning VITE_ENCRYPTION on seals new writes and nothing else. Every incident,
// injury, illness, meeting and drill filed before that moment stays in plaintext
// in the database — and what is already stored IS the exposure. That is the
// same sentence written at the top of incidentMedical.js, medicalRecords.js and
// the visibility backfill, for the same reason each time: closing the write path
// closes nothing already written.
//
// ── Why this runs in the browser and not in functions/ ───────────────────────
//
// Every other migration in this project is a Cloud Function, and this one
// deliberately is not.
//
// functions/ deploys as its own package and cannot import from src/, so a
// server-side version would need its own copy of the policy table AND its own
// copy of the path walker. The AAD bound into every sealed value IS the policy
// path string — `capa[].owner`, not `capa[0].owner` — so the two copies would
// have to agree character for character, forever. They would not: MEDICAL_FIELDS
// and REGION are already duplicated across that seam with a comment begging
// whoever edits one to edit the other.
//
// The failure mode if they ever drifted is the worst one available. A value
// sealed under `capa[].owner` and read under `capa[].ownerName` does not throw
// at write time, does not throw at read time, and cannot be recovered: it fails
// its authentication tag forever, and the plaintext it replaced is gone. A
// silent, permanent, irreversible loss of occupational health records, caused by
// a typo in a duplicated string.
//
// So this uses the app's own sealDoc, against the app's own policy, through the
// app's own key material. There is exactly one implementation, and the migration
// cannot seal anything differently from the way a normal save would.
//
// What that costs is the Admin SDK: this runs as a signed-in administrator and
// is bound by firestore.rules like any other client code. That is acceptable
// here — an admin can already read and write every collection in this table —
// and it buys something a Cloud Function could not have: the person running the
// migration holds BOTH key classes, so every document can be opened again and
// checked before its plaintext is overwritten.
//
// ── The safety property ──────────────────────────────────────────────────────
//
// Nothing is written until the sealed copy has been decrypted back and compared,
// field by field, against the plaintext it would replace. The check is local and
// costs no round trip, and it happens BEFORE the destructive write rather than
// after — which is the one ordering difference from confineMedicalRecords, and
// it is forced by the shape of the job. That migration COPIED, so it could write
// first and verify before deleting the original. This one OVERWRITES: there is
// no moment after the write where the plaintext still exists to be compared
// against. Verify first, or do not verify at all.
//
// A document that fails the check is left exactly as it was and reported.
//
// ── Idempotent, resumable, and safe to run with the switch off ───────────────
//
// sealValue passes an already-sealed value through untouched, so a re-run costs
// reads and writes nothing. A run interrupted half way leaves every document
// either fully sealed or fully plaintext — never half of one — because each
// document is one write.
//
// It does need VITE_ENCRYPTION=on, because sealDoc is a no-op without it. A run
// attempted with sealing off would report every document as "nothing to do" and
// look like a success, which is why that is checked first and refused loudly.
// ─────────────────────────────────────────────────────────────────────────────
import { collection, getDocs, query, updateDoc, where } from '../data/client.js'
import { db } from '../db'
import { POLICY, policyFor, leafRefs, MEDICAL } from './policy'
import { sealDoc, openDoc } from './index'
import { sealingEnabled, canOpen } from './keyring'

/**
 * How many documents one run may seal.
 *
 * Each one is a read, a seal, a verify and a write, and the writes are what
 * bound it — this runs from a browser tab against Firestore's per-client write
 * throughput, not from a Cloud Function with a 540s budget. A cap keeps a run to
 * something a person will wait for and makes a large estate a series of finished
 * runs rather than one that is closed half way. Whatever is left comes back as
 * `remaining`.
 */
export const MAX_SEALS_PER_RUN = 400

/**
 * Where the documents are, and in what order they are visited.
 *
 * Parents before their subcollections, because a subcollection is enumerated by
 * walking its parents — and because a run that is interrupted should have
 * finished the bigger, more exposed collections first. `incidents` and
 * `injuries` lead for that reason: they are the collections the ISO findings
 * were about.
 *
 * Every entry's `collection` must be a key of POLICY. The test beside this file
 * asserts that the two lists are the same set, so a collection added to the
 * policy and forgotten here — which would leave it sealing new writes and never
 * sealing its history, silently — fails the build rather than shipping.
 */
export const TARGETS = [
  { collection: 'injuries', parent: null },
  { collection: 'injuries/records', parent: 'injuries', sub: 'records' },
  { collection: 'illnesses', parent: null },
  { collection: 'illnesses/files', parent: 'illnesses', sub: 'files' },
  { collection: 'incidents', parent: null },
  { collection: 'incidents/photos', parent: 'incidents', sub: 'photos' },
  { collection: 'consultations', parent: null },
  { collection: 'mockDrills', parent: null },
  { collection: 'mockDrills/photos', parent: 'mockDrills', sub: 'photos' },
  { collection: 'lotoPermits', parent: null },
  { collection: 'lotoPermits/events', parent: 'lotoPermits', sub: 'events' },
  { collection: 'lotoPermits/attachments', parent: 'lotoPermits', sub: 'attachments' },
  // Top-level, tenanted by an orgId field rather than by path.
  { collection: 'technicians', parent: null, root: true },
]

const topName = (spec) => String(spec).split('.')[0].replace('[]', '')

/**
 * The top-level fields a collection's policy can touch.
 *
 * The unit of an update is a top-level field: `horizontal.details` cannot be
 * written without writing `horizontal`, and `capa[].owner` cannot be written
 * without writing the whole `capa` array. So this is what gets sent, and only
 * for the names actually present on the document — a migration that added an
 * empty `horizontal` to every incident that never had one would be filling the
 * database with scaffolding for fields nobody filled in.
 */
export function writableFields(collection, docData) {
  const policy = policyFor(collection)
  if (!policy || !docData) return []
  const names = new Set(policy.fields.map(topName))
  return [...names].filter((n) => n in docData)
}

/**
 * Does this document still hold anything unsealed that the policy covers?
 *
 * Cheap, and the reason a re-run costs almost nothing: a fully sealed document
 * is recognised without decrypting a single value.
 */
export function needsSealing(collection, docData) {
  const policy = policyFor(collection)
  if (!policy || !docData) return false
  for (const spec of policy.fields) {
    for (const ref of leafRefs(docData, spec)) {
      const v = ref.parent[ref.key]
      if (v === undefined) continue
      // A non-string cannot be an envelope, so it is by definition unsealed.
      if (typeof v !== 'string' || !v.startsWith('enc:')) {
        if (typeof v === 'string' && v.startsWith('enk:')) continue
        return true
      }
    }
  }
  return false
}

/**
 * Every policy-covered value, flattened, for comparison.
 *
 * Compared as JSON rather than by identity because the values round-trip
 * through JSON.stringify/parse inside the envelope: an array comes back a new
 * array, and an object a new object, holding the same things.
 */
function policyValues(collection, docData) {
  const policy = policyFor(collection)
  const out = []
  for (const spec of policy.fields) {
    for (const ref of leafRefs(docData, spec)) {
      out.push(`${spec}=${JSON.stringify(ref.parent[ref.key] ?? null)}`)
    }
  }
  return out
}

/**
 * Did the sealed copy survive being opened again?
 *
 * THIS PREDICATE IS THE SAFETY PROPERTY. Nothing is written until it answers
 * true, so a key that is subtly wrong, a policy path that changed shape, or a
 * value that JSON cannot round-trip leaves the document in plaintext and
 * reported, instead of replacing a colleague's medication with a string nothing
 * will ever decrypt.
 *
 * The count is compared as well as the values, because a redacted field is
 * REMOVED rather than nulled — so a reader missing a key produces a shorter
 * list, not a list of nulls, and that has to fail.
 */
export function opensBackIntact(collection, before, after) {
  if (!before || !after) return false
  const a = policyValues(collection, before)
  const b = policyValues(collection, after)
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

/**
 * Seal one document and prove it can be read again.
 *
 * Returns `{ ok, update, reason }`. `update` is the partial payload to write,
 * and is null when there is nothing to do or when the check failed.
 */
export async function sealAndVerify(orgId, collection, docData) {
  if (!needsSealing(collection, docData)) return { ok: true, update: null, reason: 'already-sealed' }

  // `id` is a local handle the readers attach, not a stored field. Sealing is
  // unaffected by it, but it must not be written back into the document.
  // Both are local handles the readers attach — `id` from the snapshot,
  // `_restricted` from openDoc — and neither is a stored field, so neither may
  // be written back into the document.
  // eslint-disable-next-line no-unused-vars -- destructured to REMOVE them
  const { id, _restricted, ...stored } = docData

  const sealed = await sealDoc(orgId, collection, stored)
  if (sealed === stored) return { ok: false, update: null, reason: 'sealing-produced-nothing' }

  const reopened = await openDoc(orgId, collection, sealed)
  if (!opensBackIntact(collection, stored, reopened)) {
    return { ok: false, update: null, reason: 'failed-round-trip' }
  }

  const fields = writableFields(collection, stored)
  if (!fields.length) return { ok: true, update: null, reason: 'nothing-to-write' }

  const update = {}
  for (const f of fields) update[f] = sealed[f]
  return { ok: true, update, reason: 'sealed' }
}

// ── The run ──────────────────────────────────────────────────────────────────

const colRef = (orgId, name) => collection(db, 'organizations', orgId, name)
const subRef = (orgId, parent, id, sub) =>
  collection(db, 'organizations', orgId, parent, id, sub)

/** Every document of one target, as `{ ref, data }`. */
async function readTarget(orgId, target) {
  const rows = []
  if (target.root) {
    // A root collection is shared by every tenant; the query is what keeps this
    // run inside one organization (and the rules refuse a read that is not
    // constrained to it).
    const snap = await getDocs(query(collection(db, target.collection), where('orgId', '==', orgId)))
    for (const d of snap.docs) rows.push({ ref: d.ref, data: { id: d.id, ...d.data() } })
    return rows
  }
  if (!target.parent) {
    const snap = await getDocs(colRef(orgId, target.collection))
    for (const d of snap.docs) rows.push({ ref: d.ref, data: { id: d.id, ...d.data() } })
    return rows
  }
  // Subcollections are reached by walking their parents rather than with a
  // collectionGroup query. A collectionGroup needs its own rules match — a
  // SECOND grant on the same data, and the one easiest to write too wide — and
  // this job runs once. The same reasoning subscribeMedicalRecords records for
  // preferring one listener per person.
  const parents = await getDocs(colRef(orgId, target.parent))
  for (const p of parents.docs) {
    const snap = await getDocs(subRef(orgId, target.parent, p.id, target.sub))
    for (const d of snap.docs) rows.push({ ref: d.ref, data: { id: d.id, ...d.data() } })
  }
  return rows
}

/**
 * Seal one collection's history.
 *
 * Reports without writing unless `dryRun: false`. A dry run still does the full
 * seal and the full verification — it simply does not write — so the numbers it
 * reports are the numbers a real run would produce, and a document that would
 * fail the check is named before anything is touched.
 */
export async function backfillCollection(orgId, target, { dryRun = true, cap = MAX_SEALS_PER_RUN } = {}) {
  const name = target.collection
  const rows = await readTarget(orgId, target)

  let sealed = 0
  let alreadySealed = 0
  const blocked = []
  let remaining = 0

  for (const row of rows) {
    if (!needsSealing(name, row.data)) { alreadySealed += 1; continue }
    if (sealed >= cap) { remaining += 1; continue }

    const result = await sealAndVerify(orgId, name, row.data)
    if (!result.ok) {
      // NEVER the field values, and never the filename — the same rule
      // planMedicalStrip and planMedicalRecordMove follow. A migration report
      // that printed what it could not seal would be one more copy of the thing
      // being confined, in a function response and in whatever logs it.
      blocked.push({ collection: name, id: row.data.id, reason: result.reason })
      continue
    }
    if (!result.update) { alreadySealed += 1; continue }

    if (!dryRun) await updateDoc(row.ref, result.update)
    sealed += 1
  }

  return { collection: name, scanned: rows.length, sealed, alreadySealed, blocked, remaining }
}

/**
 * Seal every collection's history, in the order TARGETS lists them.
 *
 * Refuses to start unless sealing is switched on and this session can OPEN both
 * key classes. Both refusals are the same defence: a run by someone who cannot
 * decrypt would fail every verification and report the entire estate as blocked,
 * which reads as a broken migration rather than as the wrong person running it.
 * Better to say so in one sentence before touching anything.
 */
export async function backfillAll(orgId, { dryRun = true, cap = MAX_SEALS_PER_RUN, onProgress } = {}) {
  if (!orgId) throw new Error('An organization is required.')
  if (!sealingEnabled) {
    throw new Error(
      'Encryption is switched off for this build, so there is nothing to seal with. ' +
      'Set VITE_ENCRYPTION=on, redeploy, and run this again.',
    )
  }
  if (!(await canOpen(orgId, MEDICAL))) {
    throw new Error(
      'Sealing history needs an account that can read health records, so the migration ' +
      'can prove every record it seals can still be opened. Run this as an administrator.',
    )
  }

  const results = []
  let budget = cap
  for (const target of TARGETS) {
    onProgress?.(target.collection)
    const r = await backfillCollection(orgId, target, { dryRun, cap: budget })
    results.push(r)
    // One budget across the whole run, not one per collection: the cap exists to
    // bound the WRITES a single run performs, and nine independent caps would
    // let one run write nine times that.
    budget -= r.sealed
    if (budget <= 0) budget = 0
  }

  return {
    dryRun,
    results,
    scannedTotal: results.reduce((n, r) => n + r.scanned, 0),
    sealedTotal: results.reduce((n, r) => n + r.sealed, 0),
    alreadySealedTotal: results.reduce((n, r) => n + r.alreadySealed, 0),
    remainingTotal: results.reduce((n, r) => n + r.remaining, 0),
    blocked: results.flatMap((r) => r.blocked),
    blockedTotal: results.reduce((n, r) => n + r.blocked.length, 0),
  }
}

/** Exported for the test that keeps TARGETS and POLICY in step. */
export const POLICY_COLLECTIONS = Object.keys(POLICY)
