// ─────────────────────────────────────────────────────────────────────────────
// Database seam — the one door between the app and the actual database.
//
// THIS COMMENT IS THE SPECIFICATION. An adapter is correct when it satisfies
// every guarantee written below; nothing else about a backend is assumed.
//
// ── Addressing ───────────────────────────────────────────────────────────────
// Every path is a '/'-separated COLLECTION path string ('organizations/<orgId>/
// incidents', 'qr', 'procedures'), and a document is addressed as (path, id).
//
// Deliberately NOT org-scoped by construction. The public QR mirrors ('qr/
// <token>', 'permitQr/<token>', 'procedureQr/<id>'), 'orgIndex/<key>', 'users/
// <uid>' and LOTO's top-level collections have to be writable in the SAME batch
// as an org-scoped document — and that pairing is a safety property, not an
// optimisation: a stale mirror tells someone standing at a machine it is
// isolated when the lock is already off. A path builder that could only express
// organizations/… could not carry roughly a third of this app's writes.
// Tenancy is enforced by the backend's rules, never by the shape of a path.
//
// ── Query options ────────────────────────────────────────────────────────────
//   opts = {
//     where?:   [{ field, op, value }, ...]   op ∈ '==' | '>=' | '<=' | 'in'
//     orderBy?: [field, 'asc'|'desc']         single field
//     limit?:   number
//   }
// Those four operators are the ones the app uses; 'in' takes an array and the
// caller does its own chunking (see documents/lib/readScope.js, which already
// emits exactly this descriptor shape). No cursors: startAfter/startAt appear
// nowhere in this codebase — every pager slices a capped in-memory array. Do
// not add pagination for a hypothesis.
//
// ── Sentinels ────────────────────────────────────────────────────────────────
// Opaque values. Callers only ever drop them into a write payload, so an
// adapter may represent them however it likes.
//
//   serverTimestamp()        the backend's own clock, resolved at write time
//   increment(n)             atomic numeric add — must survive concurrent
//                            writers WITHOUT a read (stats deltas depend on it)
//   arrayUnion(...values)    append-if-absent, atomic
//
// ── Reads ────────────────────────────────────────────────────────────────────
//   get(path, id)                        -> {id, ...} | null
//   list(path, opts)                     -> [{id, ...}]
//   count(path, opts)                    -> number | null
//   subscribe(path, opts, cb, onError)   -> unsubscribe
//   subscribeDoc(path, id, cb, onError)  -> unsubscribe
//
// `null` from get (and from subscribeDoc's callback) MEANS ABSENT and is never
// an error. A refusal or a network failure REJECTS. Those two must stay
// distinguishable at every level of this contract.
//
// count is the cheap aggregate — a count that reads the documents is not an
// implementation of it. It returns null when the driver has no aggregation at
// all, which callers handle by omitting the stat rather than guessing; a driver
// that HAS one rejects on refusal like every other read.
//
// Both subscribes MUST return their unsubscribe synchronously, so an adapter
// may not await anything before wiring the listener. That is also why DRIVERS
// below is a static registry rather than the dynamic import shared/storage uses
// — an async-loaded adapter cannot hand back an unsubscribe in time.
//
// The FIRST emission must arrive asynchronously, as Firestore's does. An
// adapter that calls cb inline lets callers that set state in the callback
// before their subscribe() returns pass in tests and fail in the browser.
//
// onError must be CALLED, not swallowed (shared/org/orgData.js and
// modules/cctv/lib/firestore.js both branch on it): "the read failed" rendered
// as "there is nothing here" is the most dangerous way for a safety system to
// be wrong. Cap detection stays with the caller — rows.length >= CAP.
//
// ── Writes ───────────────────────────────────────────────────────────────────
//   newId(path)                          -> id
//   create(path, data)                   -> id
//   set(path, id, data, {merge})         -> void
//   createExclusive(path, id, data)      -> void
//   update(path, id, data)               -> void
//   remove(path, id)                     -> void
//
// newId is SYNCHRONOUS and does no I/O, and its value must be usable as the id
// of a later set()/batch op. That is what lets a QR mirror carry the id of the
// document written beside it in the same batch — the id is needed before the
// write, not after it.
//
// set with merge:false replaces the document wholesale; merge:true writes only
// the fields named. update takes dotted keys ('byStatus.active') addressing
// nested fields — a guarantee, not a Firestore accident.
//
// update MUST REJECT WHEN THE DOCUMENT DOES NOT EXIST. This is load-bearing and
// very easy to "fix" into a bug: incidents' bumpStats leans on the rejection to
// seed its stats document, and the seed deletes nextSeq first because a merge
// carrying nextSeq: 0 would rewind the reference-number counter and hand the
// next incident a number already printed on another one. An adapter that
// quietly upserts defeats the whole dance.
//
// remove on a document that is not there is not an error.
//
// ── Composition ──────────────────────────────────────────────────────────────
//   batch() -> { set, update, remove, createExclusive, commit() }
//   runTransaction(fn) -> fn(tx) where tx = { get, set, update }
//
// A batch is ALL-OR-NOTHING ACROSS ARBITRARY COLLECTIONS — commit() resolves
// only once every op is durable, and if one fails none applied. Chunking stays
// with the caller: the 200/400-op loops in fire and orgData exist because
// Firestore caps a batch at 500, and they are correct for any backend with a
// limit and harmless for one without.
//
// A transaction's fn may run MORE THAN ONCE and must have no side effect beyond
// tx. A throw rolls back and propagates unchanged — LOTO throws its lockout
// rules from inside one and expects nothing written. Every tx.get must precede
// the first tx write. tx.remove is deliberately absent: no call site needs it,
// and an unused primitive is one more thing each adapter has to get right.
//
// ── createExclusive: atomic, or it is not implemented ─────────────────────────
// The existence test and the write are ONE operation at the backend. Never get
// then set. This backs a safety control — the fire defect lock is what stops
// the same fault being reported twice, and it is written inside a batch
// together with the report so nothing can slip in between.
//
//   Firestore  set() on a path whose rules grant create and nothing else. The
//              RULE is the isolation.
//   SQL        INSERT … ON CONFLICT DO NOTHING with a rowcount check, or a
//              primary-key violation. Not SELECT then INSERT.
//   In-memory  one synchronous section, plus batch-wide validation before any
//              op in the batch is applied.
//
// A check-then-set adapter passes every test on a quiet day and corrupts under
// load. The contract suite for a driver must include a batch pairing a
// colliding createExclusive with a second write, and assert the second write
// did not land.
//
// ── Errors ───────────────────────────────────────────────────────────────────
//   isWriteRefused(e) -> boolean
//
// True for a rules refusal AND for an exclusive-create collision, because on
// Firestore they are the same error: /defectLocks grants create only, so a
// duplicate comes back permission-denied and never already-exists. One
// predicate is all any caller needs; adapters rethrow the driver's error
// VERBATIM so e.code still reaches anyone who needs more than the predicate.
//
// ── What this seam does not carry ────────────────────────────────────────────
// Stored values pass through unchanged in both directions, Firestore Timestamps
// included — 16 files read .seconds/.toDate() and three sorts would fail
// silently if the shape changed (an all-zero comparator leaves the original
// order, so the list looks fine and is simply wrong). Normalising the read
// shape is a separate task with a data migration attached.
//
// Nor rules-coupled write semantics (docSeq's monotonic n, defectLocks'
// create-only, orgIndex): the seam carries the call, the backend enforces the
// rule. Nor Firestore query quirks the app relies on — where('x','==',null) not
// matching a MISSING field, and orderBy silently dropping documents without the
// ordered field. A SQL adapter will return those rows; say so in its notes
// rather than emulating it.
//
// Which implementation backs the seam comes from VITE_DATA_DRIVER (default
// 'postgres': this installation's server). 'memory' exists for tests and
// demos. Adding a backend = one adapter file implementing everything above
// plus a line in DRIVERS. ./README.md is the contract note that sits next to
// the code.
// ─────────────────────────────────────────────────────────────────────────────
import memory from './adapters/memory'
import postgres from './adapters/postgres'
import { resolveDataDriver } from './resolveDriver'
import { runtimeEnv } from '../runtimeConfig'

// Static registry (not dynamic imports): subscribe() must return an
// unsubscribe function synchronously, which an async-loaded adapter cannot do
// without every caller changing shape. A path 3 SDK pays that cost on the
// day it is registered — do not "fix" it with a dynamic import.
const DRIVERS = {
  postgres, // this installation's server. The browser talks to the gateway; RLS enforces.
  memory, // in-process, for tests and demos — NOT a production store
}

// Throws UnimplementedDataDriverError for a reserved name. Anything else that
// is not registered resolves to postgres.
export const dataDriver = resolveDataDriver(runtimeEnv('DATA_DRIVER'), DRIVERS)
export const dataProvider = DRIVERS[dataDriver]
