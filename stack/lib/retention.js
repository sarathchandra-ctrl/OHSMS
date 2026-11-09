/**
 * Making the Recycle Bin's promise true.
 *
 * The screen says "Auto-purged after 30 days" and renders a per-row countdown.
 * Nothing implemented it: soft-deleted records sat in the database for as long
 * as the project existed, including illness records carrying health data,
 * unless a human remembered to click Purge. The countdown ran down to zero and
 * then kept going.
 *
 * A stated retention period that nothing enforces is worse than none at all —
 * it is a control an auditor will test, a claim a data subject can rely on, and
 * the reason someone stops worrying about the delete they performed.
 *
 * Pure planning only. Nothing here reads or writes Firestore; index.js does
 * that with what these functions decide, which is what makes the decisions
 * testable without a database and the destructive half small enough to read.
 */

/** The window the UI has always claimed. */
export const PURGE_AFTER_DAYS = 30

/**
 * How many documents one scheduled run may destroy.
 *
 * A scheduled hard delete is the most dangerous thing in this codebase: it is
 * irreversible, unattended, and its blast radius is every tenant. The cap means
 * a mistake in the query costs one run's worth of damage and shows up in the
 * logs, rather than emptying the database before anyone reads them. A real
 * backlog drains over consecutive days, which is fine for something already
 * 30 days dead.
 */
export const MAX_PURGES_PER_RUN = 500

/** Collections that soft-delete, and what has to go with each. */
export const PURGEABLE = [
  // Photos carry Storage objects; the pointer must not outlive the file, nor
  // the file the pointer.
  { collection: 'incidents', subcollections: ['photos'] },
  { collection: 'illnesses', subcollections: ['files'] },
  // Injury reports, and the clinical documents hanging off them.
  //
  // This collection was absent from this list, and the absence was not one
  // missing line — it was the whole lifecycle. An injury had NO soft-delete
  // path at all: `deletedAt` was written as null by injuryPayload and read back
  // by the list filter, and nothing anywhere ever set it. So the field looked
  // like a lifecycle and implemented none, and /injuries — the only home of a
  // named colleague's body parts, injury type, medication and days off, plus
  // the GP letters and fit notes in `records` — was the one collection in this
  // app whose contents could not be deleted by any route the product offered.
  //
  // Comments in four other files refer to a `purgeIncidentMedicalRecords` that
  // would find these by querying on the join keys. No such function has ever
  // existed. That is worth stating here rather than quietly adding the entry,
  // because the comments are what made the gap invisible: the codebase
  // described a deletion path it did not have, and reading it left you
  // believing this was handled.
  //
  // ── Why purging an INCIDENT does not reach its injuries ────────────────────
  //
  // An injury report is deliberately a record in its own right, not an
  // attachment: its own register, its own audience (isManagerOf, so the outside
  // auditor is refused), its own verification workflow, its own key class. The
  // /injuries page lists the whole collection, so one whose incident has been
  // purged is still found and still readable — what breaks is the link back to
  // a parent that no longer exists, which is a dangling reference, not hidden
  // data.
  //
  // So a cascade was considered and NOT taken. Purging an incident destroys
  // what the manager asked to destroy; it must not also destroy occupational
  // health records nobody asked to delete and that statute may require be kept.
  // That is the same direction isExpired takes below, and for the same reason:
  // keeping a record too long is a finding, destroying a live one is the
  // record. An injury leaves this collection when somebody deletes THAT, and
  // then only after the same 30 days everything else gets.
  //
  // ── What is still open ────────────────────────────────────────────────────
  //
  // How long an injury nobody deletes should be kept. This entry gives the
  // collection a lifecycle; it does not give it a maximum age, and a record
  // sitting here undeleted is kept indefinitely, exactly as before. That period
  // is a legal question, not an engineering one — occupational injury records
  // carry a statutory minimum in most jurisdictions and an indefinite hold is
  // not made lawful by a statutory floor. docs/DATA-RIGHTS.md §3 is where the
  // decision belongs, and planPurge already takes `days` per call, so enforcing
  // one is a `days` on this entry and a line in purgeOrgCollection — not a
  // redesign. It is deliberately absent until someone with the authority to
  // answer has answered.
  { collection: 'injuries', subcollections: ['records'] },
  // The QR mirror is public and keyed by token, so it lives outside the org
  // path — deleting the asset without it leaves a world-readable record of
  // equipment that no longer exists.
  { collection: 'extinguishers', qrMirror: true },
  { collection: 'aeds', qrMirror: true },
  { collection: 'fas', qrMirror: true },
  { collection: 'signages', qrMirror: true },
]

/** Millisecond timestamp from whatever shape the field arrived in. */
export function toMillis(value) {
  if (value == null) return null
  if (typeof value?.toMillis === 'function') return value.toMillis()
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value === 'object' && typeof value.seconds === 'number') return value.seconds * 1000
  const parsed = Date.parse(String(value))
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Is this record past its window?
 *
 * Anything without a readable deletedAt is NOT expired. A missing or unparseable
 * timestamp means "we do not know when this was deleted", and the safe answer to
 * that is to leave it alone — the cost of keeping a record too long is a finding,
 * the cost of destroying a live one is the record.
 */
export function isExpired(deletedAt, now = Date.now(), days = PURGE_AFTER_DAYS) {
  const ms = toMillis(deletedAt)
  if (ms == null) return false
  return now - ms >= days * 24 * 60 * 60 * 1000
}

/** Days remaining before a record is eligible; 0 once it is. */
export function daysRemaining(deletedAt, now = Date.now(), days = PURGE_AFTER_DAYS) {
  const ms = toMillis(deletedAt)
  if (ms == null) return null
  const left = days * 24 * 60 * 60 * 1000 - (now - ms)
  return left <= 0 ? 0 : Math.ceil(left / (24 * 60 * 60 * 1000))
}

/**
 * Which of these documents may be destroyed, and which are kept and why.
 *
 * Returns both halves on purpose. A job that reports only what it destroyed
 * cannot be checked; the kept list is what tells someone reading the logs that
 * the query is selecting what they think it is.
 */
export function planPurge(docs = [], { now = Date.now(), days = PURGE_AFTER_DAYS, max = MAX_PURGES_PER_RUN } = {}) {
  const purge = []
  const keep = []

  for (const d of docs || []) {
    if (!d) continue
    // Never destroy a record that is not in the bin. A query is a filter, not a
    // guarantee — this is the one check that must not depend on getting it right.
    if (d.deletedAt == null) {
      keep.push({ id: d.id, reason: 'not deleted' })
      continue
    }
    if (!isExpired(d.deletedAt, now, days)) {
      keep.push({ id: d.id, reason: `${daysRemaining(d.deletedAt, now, days)} days left` })
      continue
    }
    if (purge.length >= max) {
      keep.push({ id: d.id, reason: 'over the per-run cap' })
      continue
    }
    purge.push(d.id)
  }

  return { purge, keep, capped: keep.some((k) => k.reason === 'over the per-run cap') }
}

/**
 * Turn a run's collected failures into the decision "does this invocation fail?"
 *
 * The sweep is deliberately resilient: one bad org must not stop the rest, so
 * every error inside it is caught. For a long time that was the whole story,
 * and it meant the most dangerous code in the system — unattended, irreversible
 * deletion of occupational-health records — reported success no matter what
 * happened inside it. `retryCount` is 0 and nothing ever threw, so a sweep that
 * had been failing for months looked exactly like one with nothing to do, while
 * the app went on telling users their data is purged after 30 days.
 *
 * So: do all the work, then fail. The resilience is unchanged; only the
 * reporting is. A thrown error at the end marks the invocation FAILED, which is
 * the signal Cloud Monitoring alerts on without any extra instrumentation
 * (PRODUCTION.md 2a).
 *
 * Pure so the "when do we shout" decision is testable without a database —
 * which is the same reason planPurge lives here rather than in index.js.
 *
 * Returns null when the run was clean.
 */
export function summarizeFailures(failures = []) {
  const list = (failures || []).filter(Boolean)
  if (!list.length) return null

  const byKind = {}
  for (const f of list) {
    const kind = f?.kind || 'unknown'
    byKind[kind] = (byKind[kind] || 0) + 1
  }

  return {
    total: list.length,
    byKind,
    // Kinds are sorted so the same failures always produce the same message —
    // an alert that reworded itself run to run would defeat any grouping the
    // alerting side does.
    message:
      `retention sweep completed with ${list.length} failure(s): ` +
      Object.keys(byKind).sort().map((k) => `${k}=${byKind[k]}`).join(', '),
  }
}
