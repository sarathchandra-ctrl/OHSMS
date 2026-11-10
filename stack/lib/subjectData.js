// ─────────────────────────────────────────────────────────────────────────────
// Where one person's data lives, for subject access and erasure requests.
//
// This system stores occupational-health data — injuries, illnesses, medical
// restrictions, GP letters. Under GDPR and India's DPDP Act that is sensitive
// personal data, and a person may ask to see all of it, or to have it deleted.
// Neither question can be answered without first knowing every place their data
// is, and that is what this file is.
//
// ── The one thing to understand before using any of it ──────────────────────
//
// A person appears in this database in TWO fundamentally different ways, and
// only one of them can be found by a query:
//
//   JOINED     A structural key names them: `personId` on an injury,
//              `employeeUid` on a training record, `actorUid` in the audit log,
//              the uid in their own /users profile. These are indexed,
//              queryable, exact, and complete. Every one of them is found.
//
//   MENTIONED  Their NAME appears as free text inside an object in an array —
//              `affectedPersonnel[].name` on an incident, `attendees[].name` in
//              committee minutes, `commanders[]` on a drill, `capa[].owner` on
//              an action. Firestore cannot query inside array objects for a
//              substring, so these cannot be found by any query. They can only
//              be found by reading every document in the collection and looking.
//
// Pretending the second kind does not exist would produce an export that looks
// authoritative and is incomplete, which is worse than one that says where it
// stopped. So the planner reports both, separately and by name, and the caller
// decides how much work to do.
//
// ── And the interaction that will break this later ──────────────────────────
//
// Application-layer encryption (src/shared/crypto/policy.js) seals exactly the
// MENTIONED fields — names are personal data, so of course it does. Join keys
// are deliberately left readable so queries keep working, which is why the
// JOINED half is unaffected. But once `VITE_ENCRYPTION=on` and the backfill has
// run, a server-side scan for a name finds ciphertext, and the medical private
// key is manager-only by design. The scan then has to happen in the browser of
// somebody entitled to decrypt, or not at all.
//
// Encryption is currently off in production (SECURITY.md S-07), so a scan works
// today. It will stop working the day that changes, silently, returning zero
// matches rather than an error. `scanFeasibility()` below exists to say so out
// loud rather than let an empty result read as "this person is not mentioned".
//
// Pure. No Firestore, no Admin SDK — index.js executes what this decides, which
// is what makes the decisions testable and keeps the legal reasoning readable.
// ─────────────────────────────────────────────────────────────────────────────

/** Erasable: no statutory obligation known to require keeping it. */
export const ERASABLE = 'erasable'
/**
 * Statutory: occupational-health and safety law requires retention, and the
 * right to erasure does not reach it (GDPR Art. 17(3)(b) — processing necessary
 * for compliance with a legal obligation; DPDP Act 2023 s.17(1) carve-outs).
 *
 * This is the half of an erasure request that must be REFUSED, in writing, with
 * a reason. Silently deleting an injury record to satisfy a request would
 * destroy the employer's own evidence of what happened to that person — which
 * is very often the thing that protects them.
 */
export const STATUTORY = 'statutory'
/**
 * Anonymise rather than delete: the record must survive for aggregate safety
 * reporting, but does not need to name anybody once closed.
 */
export const ANONYMISE = 'anonymise'

/**
 * Every place a person's data can be, and how to reach it.
 *
 * `path` is relative to `organizations/{orgId}`, with `/` marking a
 * subcollection whose parent id is a wildcard — the same convention
 * `src/shared/crypto/policy.js` uses, deliberately, so the two tables can be
 * read side by side.
 *
 * ⚠️ DRIFT WARNING. This table and `POLICY` in policy.js describe the same
 * personal data for different purposes, and they live in different npm
 * packages so no import can tie them together. A collection added to one and
 * not the other is a silent gap: in policy.js it means storing a name in the
 * clear, here it means leaving it out of a subject's export. `EXPECTED_SEALED`
 * below is checked by the test suite for exactly this reason.
 */
export const SUBJECT_SOURCES = [
  // ── Their own account ──────────────────────────────────────────────────────
  // Top-level, not under the org: /users/{uid}. The directory entry itself.
  {
    path: 'users',
    topLevel: true,
    joins: [{ kind: 'docId', key: 'uid' }],
    retention: ANONYMISE,
    why: 'The account record. Removing it outright orphans every authored record that names the uid.',
  },
  // Their in-app notifications: inbox/{uid}/items. Keyed by the uid in the
  // path, so the whole collection is theirs (kind 'pathUid').
  {
    path: 'inbox/items',
    joins: [{ kind: 'pathUid', key: 'uid' }],
    retention: ERASABLE,
    why: 'Reminders addressed to the person; the records they point at are kept on their own terms.',
  },

  // ── Incidents ──────────────────────────────────────────────────────────────
  {
    path: 'incidents',
    joins: [{ kind: 'arrayField', field: 'injuryReports', match: 'personId' }],
    mentions: [
      'createdByName',
      'affectedPersonnel[].name',
      'team[].name',
      'injuryReports[].personName',
      'capa[].owner',
      'capa[].ownerName',
      'capa[].responsible',
    ],
    retention: STATUTORY,
    why: 'The accident record. Retention is required by occupational-safety law and it is the employer’s evidence of the event.',
  },
  {
    path: 'incidents/photos',
    parent: 'incidents',
    mentions: ['caption', 'name'],
    retention: STATUTORY,
    why: 'Evidence attached to a retained accident record.',
  },

  // ── Injuries: the clinical record, keyed to the person ─────────────────────
  // Doc id is `${incidentId}__${personId}`, and personId is also a field.
  {
    path: 'injuries',
    joins: [{ kind: 'field', field: 'personId', key: 'personId' }],
    mentions: ['personName'],
    retention: STATUTORY,
    why: 'Occupational injury record. Statutory retention; erasing it destroys the person’s own evidence of what happened to them.',
  },
  {
    path: 'injuries/records',
    parent: 'injuries',
    mentions: ['name', 'caption'],
    files: true,
    retention: STATUTORY,
    why: 'Medical documents attached to a retained injury record.',
  },

  // ── Illnesses ──────────────────────────────────────────────────────────────
  {
    path: 'illnesses',
    mentions: [
      'createdByName',
      'affectedPersonnel[].name',
      'actions[].owner',
      'actions[].ownerName',
    ],
    retention: STATUTORY,
    why: 'Occupational illness record. Exposure records carry the longest statutory retention of anything here.',
  },
  {
    path: 'illnesses/files',
    parent: 'illnesses',
    mentions: ['name', 'caption'],
    files: true,
    retention: STATUTORY,
    why: 'Medical documents attached to a retained illness record.',
  },

  // ── Training ───────────────────────────────────────────────────────────────
  // Joined cleanly by uid, and the one class where a competence record is
  // itself often a statutory requirement (proof the worker was trained).
  {
    path: 'trainingRecords',
    joins: [{ kind: 'field', field: 'employeeUid', key: 'uid' }],
    retention: STATUTORY,
    why: 'Proof of competence and induction; required to be held for the worker’s employment and beyond.',
  },
  {
    path: 'trainingAssignments',
    joins: [{ kind: 'field', field: 'employeeUid', key: 'uid' }],
    retention: ERASABLE,
    why: 'An assignment is scheduling, not a safety record.',
  },
  {
    path: 'trainingRequests',
    joins: [{ kind: 'field', field: 'employeeUid', key: 'uid' }],
    retention: ERASABLE,
    why: 'A request to attend; carries no safety evidence once resolved.',
  },
  // A quiz answered from its QR code (stack/quiz.mjs). The taker has no
  // account, so nothing joins them by uid: their employee ID, name, centre
  // and email address are typed text, found only by a scan. Written by the server and not sealed
  // (src/shared/crypto/policy.js says why), so a scan of it stays reliable.
  {
    path: 'quizResponses',
    mentions: ['employeeId', 'name', 'centerName', 'email'],
    retention: ERASABLE,
    why: 'A quiz attempt and its score; a certificate can be issued again from the person’s own details.',
  },

  // ── LOTO ───────────────────────────────────────────────────────────────────
  // A per-job lockout permit names the requester, approver, internal crew (by
  // uid AND name) and contractors (name only — they have no account). Reached by
  // uid for the first three; contractors can only be found by a scan.
  //
  // ERASABLE with a one-year sweep (purgeClosedLotoPermits), not STATUTORY: the
  // owner decided a closed permit is kept for a year and then destroyed, and
  // 29 CFR 1910.147 asks for a periodic-inspection certification, not a record of
  // every job. If counsel later wants permits kept for an injury investigation,
  // the retention window is LOTO_PERMIT_RETENTION_DAYS in lotoPermitSweep.js.
  {
    path: 'lotoPermits',
    joins: [
      { kind: 'field', field: 'requestedBy', key: 'uid' },
      { kind: 'arrayContains', field: 'personnelUids', key: 'uid' },
    ],
    mentions: [
      'requestedByName',
      'internalPersonnel[].name',
      'vendorWorkers[].name',
      'vendorWorkers[].company',
      'vendorWorkers[].contact',
      'locks[].techName',
      'groupLock.members[].name',
      'lockPhoto.byName',
      'approval.byName',
      'closure.byName',
      'emergency.byName',
    ],
    retention: ERASABLE,
    why: 'A per-job lockout permit. Kept one year after it closes, then purged; nothing here is a statutory record of its own.',
  },
  {
    path: 'lotoPermits/events',
    parent: 'lotoPermits',
    mentions: ['byName', 'note'],
    retention: ERASABLE,
    why: 'The permit’s timeline; goes with it.',
  },
  {
    path: 'lotoPermits/attachments',
    parent: 'lotoPermits',
    mentions: ['name', 'byName'],
    files: true,
    retention: ERASABLE,
    why: 'Files attached to a permit; goes with it.',
  },
  // The register of authorised technicians. A ROOT collection tenanted by an
  // `orgId` field (not under organizations/{orgId}), hence `topLevel` +
  // `orgField`: any query against it MUST also constrain that field or it reads
  // every tenant (see exportSubjectData).
  {
    path: 'technicians',
    topLevel: true,
    orgField: 'orgId',
    mentions: ['name', 'contact', 'licenceNo'],
    retention: ERASABLE,
    why: 'The list of people authorised to apply a lock. Remove the person and the entry has no subject.',
  },
  // Padlock register: a lock number and a type. No name or contact is stored; the
  // only personal link is the uid of whoever created the row.
  {
    path: 'locks',
    topLevel: true,
    orgField: 'orgId',
    joins: [{ kind: 'field', field: 'createdBy', key: 'uid' }],
    retention: ERASABLE,
    why: 'The padlock register. Holds no name; the creator uid is the only link to a person.',
  },

  // ── Emergency response ─────────────────────────────────────────────────────
  {
    path: 'erpContacts',
    joins: [{ kind: 'field', field: 'employeeUid', key: 'uid' }],
    retention: ERASABLE,
    why: 'A contact list entry. Remove the person and the entry has no subject.',
  },
  {
    path: 'mockDrills',
    mentions: ['commander', 'commanders[]', 'loggedBy', 'capa[].owner', 'capa[].assignees[].name'],
    retention: ANONYMISE,
    why: 'Drill performance must survive for safety reporting; it does not need to name the warden once closed.',
  },
  {
    path: 'mockDrills/photos',
    parent: 'mockDrills',
    mentions: ['dataUrl'],
    files: true,
    retention: ANONYMISE,
    why: 'Attached to a drill record that is kept in anonymised form.',
  },

  // ── Committee ──────────────────────────────────────────────────────────────
  {
    path: 'consultations',
    mentions: ['createdBy', 'attendees[].name', 'actions[].owner'],
    retention: STATUTORY,
    why: 'Minutes of statutory safety consultation. Who attended is the point of the record.',
  },

  // ── WhatsApp site lookup ───────────────────────────────────────────────────
  // ROOT collections tenanted by an `orgId` field, server-only in the rules.
  // waLinks' document id IS the person's WhatsApp number, so an export of it
  // is the number itself — which is the point of a subject access request.
  {
    path: 'waLinks',
    topLevel: true,
    orgField: 'orgId',
    joins: [{ kind: 'field', field: 'uid', key: 'uid' }],
    retention: ERASABLE,
    why: 'Consent to receive site summaries on WhatsApp, and the number it was given for. An organisation administrator can also attach the number. Withdrawing consent — UNLINK, the Security page, or the administrator removing it — deletes it.',
  },
  // phoneHash is a keyed digest, not the number. No message text is stored.
  {
    path: 'waQueryLog',
    topLevel: true,
    orgField: 'orgId',
    joins: [{ kind: 'field', field: 'uid', key: 'uid' }],
    retention: ERASABLE,
    why: 'Which site a person looked up on WhatsApp, and when. Kept 90 days for abuse review, then purged.',
  },

  // The conversation: chosen organisation and the last pick-list (site or
  // organisation ids). 24 hours idle. No coordinates, no message text.
  // A row with no uid is not this person's export. WhatsApp sessions carry the uid.
  {
    path: 'waSessions',
    topLevel: true,
    orgField: 'orgId',
    joins: [{ kind: 'field', field: 'uid', key: 'uid' }],
    retention: ERASABLE,
    why: 'Which organisation a chat had chosen, which sites or organisations were last offered, and for 15 minutes which one site the audit question is about. Expires after 24 hours idle. Numbered choices and that question stop working after 15 minutes.',
  },

  // ── The audit trail ────────────────────────────────────────────────────────
  {
    path: 'auditLogs',
    joins: [{ kind: 'field', field: 'actorUid', key: 'uid' }],
    retention: STATUTORY,
    why: 'Append-only by design and by rule. An audit trail a subject can edit is not an audit trail; erasure would remove the record of their own actions.',
  },
]

/**
 * The collections `policy.js` seals, restated so the test suite can shout when
 * the two tables drift apart. Update BOTH or neither.
 */
export const EXPECTED_SEALED = [
  'incidents',
  'incidents/photos',
  'injuries',
  'injuries/records',
  'illnesses',
  'illnesses/files',
  'consultations',
  'mockDrills',
  'mockDrills/photos',
  'lotoPermits',
  'lotoPermits/events',
  'lotoPermits/attachments',
  'technicians',
]

/**
 * The queries to run to gather everything reachable by a KEY.
 *
 * Complete and exact for what it covers. `subject` carries whichever
 * identifiers are known: `{ uid, personId }`. A source whose join key is not
 * present in `subject` is skipped rather than queried with an empty value —
 * querying `employeeUid == ''` would match every record that never had one.
 */
export function planExport(subject = {}) {
  const queries = []
  for (const src of SUBJECT_SOURCES) {
    for (const join of src.joins || []) {
      const value = subject[join.key]
      if (!value) continue
      queries.push({
        path: src.path,
        topLevel: Boolean(src.topLevel),
        // Set on a root collection that is tenanted by a FIELD. The executor
        // must add `where(orgField, '==', orgId)` or it reads every tenant.
        orgField: src.orgField || null,
        parent: src.parent || null,
        kind: join.kind,
        field: join.field || null,
        matchField: join.match || null,
        value,
        retention: src.retention,
      })
    }
  }
  return queries
}

/**
 * The collections that can only be searched by reading all of them.
 *
 * Returned separately from `planExport` so an export can never quietly present
 * the cheap half as the whole answer. Each entry names the exact field paths a
 * human or a scan has to look at.
 */
export function planScan() {
  return SUBJECT_SOURCES.filter((s) => (s.mentions || []).length).map((s) => ({
    path: s.path,
    parent: s.parent || null,
    fields: s.mentions,
    retention: s.retention,
  }))
}

/**
 * Can a server-side scan actually read those fields?
 *
 * Every scannable field is also a field `policy.js` seals, so the answer is "no"
 * the moment encryption is on. Said out loud because the failure is silent: a
 * scan over ciphertext returns zero matches, and zero matches reads exactly like
 * "this person is not mentioned anywhere".
 */
export function scanFeasibility({ encryptionOn = false } = {}) {
  if (!encryptionOn) {
    return {
      feasible: true,
      note: 'Fields are stored in the clear, so a server-side scan can read them.',
    }
  }
  return {
    feasible: false,
    reason: 'encrypted',
    note:
      'Every scannable field is sealed by src/shared/crypto/policy.js. A server-side scan ' +
      'would read ciphertext and report zero mentions, which is indistinguishable from a ' +
      'person who is genuinely not mentioned. Run the scan in the browser of someone ' +
      'entitled to the keys, or record the mentions half as not performed.',
  }
}

/**
 * What an erasure request may and may not touch.
 *
 * Deliberately NOT a delete plan. It is a classification, because the honest
 * answer to "delete everything about me" in an occupational-health system is
 * "most of it cannot be deleted, here is each part and why" — and a system that
 * silently deleted the statutory half would be destroying the employer's and the
 * worker's shared evidence of an injury.
 *
 * The refusal is the deliverable as much as the deletion is. Both go back to the
 * subject.
 */
export function classifyErasure() {
  const bucket = (r) =>
    SUBJECT_SOURCES.filter((s) => s.retention === r).map((s) => ({ path: s.path, why: s.why }))
  return {
    erasable: bucket(ERASABLE),
    anonymise: bucket(ANONYMISE),
    refused: bucket(STATUTORY),
  }
}
