// ─────────────────────────────────────────────────────────────────────────────
// WHICH fields are encrypted, and under which of the two keys.
//
// One table, read by the client on every write and every read, and by the
// backfill in functions/ when it encrypts what is already stored. It is the only
// place any of that is decided; a field that is not named here is stored in the
// clear, and that has to be a decision somebody made rather than a file somebody
// forgot to edit.
//
// ── The two key classes, and why they are the two ────────────────────────────
//
// They are not a severity scale. Each one is a copy of a boundary stack/policy.mjs
// already enforces, because a key class that does not line up with a rule either
// locks people out of data they are entitled to or hands it to people the rules
// refuse — and in both cases the rule and the key would have to be reasoned
// about separately forever after.
//
//   general   Readable and writable by every approved member, auditor included.
//             Symmetric: one org data key, held by anyone who can read the
//             collection anyway. It buys nothing against a member, and it is not
//             meant to — it is what stands between this data and everything that
//             reaches the STORE rather than the app: an exported backup, a
//             misconfigured bucket, a support engineer with project Viewer, and
//             the next rule that turns out to be one `match` too wide.
//
//   medical   readable by managers only — /injuries, its /records
//             subcollection, and /illnesses (isMedical, stack/policy.mjs). Members WRITE
//             these and cannot read them back, so this class is hybrid: the
//             public half goes to writers, the private half only to admin and
//             manager. See the header of envelope.js for why a symmetric key
//             cannot express that and would quietly undo the control.
//
// The auditor is the case worth stating plainly, because it is the finding this
// whole exercise came out of. An auditor is an outside party with a login. They
// get the general key, because inspecting the safety record is their job. They
// are refused the medical private key by the same test that refuses them the
// documents — so if the injuries rule is ever widened by accident, they get
// ciphertext instead of a colleague's medication.
//
// ── Path syntax ──────────────────────────────────────────────────────────────
//
//     field                a top-level field
//     parent.child         a nested object
//     list[].child         `child` on every element of the `list` array
//     list[]               every element of `list`, when they are scalars
//
// The path as WRITTEN here is what gets bound into the ciphertext — never the
// concrete index. `capa[].owner` is the binding for every element, so reordering
// the array, inserting at the front, or deleting an entry leaves the rest
// readable. Binding `capa[3].owner` would make a drag-to-reorder into silent
// data loss.
//
// ── What is deliberately NOT encrypted ───────────────────────────────────────
//
//   · Anything a query filters or orders on. Every `where` in this app is on a
//     structural key (orgId, incidentId, personId, sessionId, permitId,
//     employeeUid, deletedAt) and every `orderBy` is on a timestamp — which is
//     the reason this change needs no query rewrites at all. Encrypting one of
//     them would mean a client-side scan of the whole collection instead.
//   · Anything the server's access rules read: status, role, access and
//     mustChangePassword on /users; the server cannot decrypt, so a sealed value
//     there would raise, and a rule that raises denies — locking every member
//     out of the app at once.
//   · The /users directory itself. Names ARE personal data and this leaves them
//     in the clear, which is a real limitation and not an oversight: the name of
//     a person is denormalised onto dozens of records (`createdByName`,
//     `personName`, `loggedBy`, `owner`, `attendees[].name`), and sealing the
//     directory while fifty copies stay readable is precisely the mistake the
//     injury/incident split was made to correct — confining one copy and
//     calling it confined. The copies are what this table seals. Sealing the
//     directory as well is a separate change that has to take email, sign-in
//     and provisioning with it.
//   · Reference numbers, ids, dates, sites, regions, entities, lifecycle and
//     status. Operational context that every list, filter and roll-up groups by,
//     and none of it is special-category data on its own.
//   · Training quiz responses (quizResponses): the employee ID, name, centre and
//     email address someone typed when answering a quiz from its QR code (the
//     address is where a passing certificate is mailed). The SERVER writes
//     them, for a person with no account and so no key, and the server cannot
//     seal. Read by managers only (stack/policy.mjs MANAGER_READ_ONLY), and
//     listed in stack/lib/subjectData.js so a person's own export finds them.
// ─────────────────────────────────────────────────────────────────────────────

/** The two classes. Values are the ids the callable and the keyring use. */
export const GENERAL = 'general'
export const MEDICAL = 'medical'
export const KEY_CLASSES = [GENERAL, MEDICAL]

/** Hybrid for medical, symmetric for general. Derived here so nothing guesses. */
export const isHybridClass = (keyClass) => keyClass === MEDICAL

/**
 * The AAD label for file BYTES.
 *
 * Per class rather than per collection, deliberately. Files in this app move
 * between collections — confineMedicalRecords lifts an object from the
 * `incident-photos` prefix to `medical-records` and its pointer from
 * incidents/{id}/photos to injuries/{id}/records — and a label naming the
 * collection would turn that migration into an unopenable file. Naming the
 * class keeps the one binding that matters: a medical object replayed as a
 * general one still fails.
 */
export const fileLabel = (keyClass) => `file:${keyClass}`

/**
 * Collection → what to seal.
 *
 * Keys are the collection path under `organizations/{orgId}/`, with `/` for a
 * subcollection and the wildcard id segments dropped: `injuries/records` is
 * `organizations/{orgId}/injuries/{injuryId}/records/{recordId}`.
 *
 * ── `files: true` seals the BYTES, not just the pointer ─────────────────────
 *
 * Sealing a FIELD is invisible to the renderers, because openDoc hands them the
 * plaintext back. Sealing the bytes in the bucket is not: something has to fetch
 * the object through getBlob, decrypt it, and build a URL from the plaintext.
 *
 * Every gallery in this app reads one field — `.dataUrl` — because the data
 * layer normalises `data.dataUrl || data.url` before anything sees it. That
 * contract is why the incident gallery, the drill recorder, the detail modals
 * and all three printed PDF documents need no knowledge of where bytes live,
 * and it is exactly what an encrypted object breaks: `.url` points at
 * ciphertext, and an <img> given that URL renders a broken image.
 *
 * Rather than move a dozen renderers — including the three PDF paths, which are
 * the outputs people rely on for compliance and the hardest thing here to test —
 * the decryption happens at the SEAM, in shared/storage/resolveFiles.js. The
 * pointer list goes in and a list with usable `.dataUrl` values comes out, so
 * not one renderer changed.
 *
 * Turning this on is safe for history. An unsealed object has no encryption
 * metadata, so isSealedFile is false, nothing is fetched, and it keeps the
 * `.url` it always had. Only new uploads take the new path — which means the
 * flag can be set before the objects already in the bucket are re-encrypted.
 *
 * What each `files: true` costs is a blob: URL per sealed object, and a blob URL
 * pins its bytes until revoked. resolveFiles hands back a `revoke` and the
 * callers have somewhere natural to put it: a subscription already returns an
 * unsubscribe, so the previous batch is released when a new snapshot arrives and
 * the last when the listener stops.
 */
export const POLICY = {
  // ── Incidents ──────────────────────────────────────────────────────────────
  // The clinical detail that used to ride along here is gone (see injuries.js);
  // what is left is the account of what happened and who was involved.
  incidents: {
    keyClass: GENERAL,
    fields: [
      'narrative',
      'probableCause',
      'createdByName',
      // Both use PersonEditor's shape: { id, kind, uid, name, dept, company,
      // contact, role }. `id` and `uid` are join keys and stay readable.
      'affectedPersonnel[].name',
      'affectedPersonnel[].contact',
      'affectedPersonnel[].company',
      'affectedPersonnel[].dept',
      'team[].name',
      'team[].contact',
      'team[].company',
      'team[].dept',
      // The stub the incident is allowed to keep. personId is the join key into
      // /injuries and must stay readable; the NAME beside it need not.
      'injuryReports[].personName',
      'investigations[].summary',
      // The chronology of the event. `event` is the same class of text as
      // `narrative` — it names people, describes injuries and quotes what was
      // said — and `source` names the witness or the camera it came from.
      // `date` and `time` stay readable: they are the sort key, and a timeline
      // that can only be ordered after decryption cannot be ordered by a query.
      'chronology[].event',
      'chronology[].source',
      // The Action Tracker reads these across every module. It filters and sorts
      // on them in the browser, after decryption, so sealing them costs nothing
      // — see actions/lib/sources.js.
      'capa[].description',
      'capa[].title',
      'capa[].owner',
      'capa[].ownerName',
      'capa[].responsible',
      'horizontal.details',
    ],
  },
  // `dataUrl` is on this list for the same reason it is on the other three
  // file-bearing collections, and leaving it off was a real gap found by running
  // the migration against production: when the bucket is unavailable, putFile
  // returns null and the image is written base64 INSIDE this document. That
  // copy has no Storage object, so the object backfill skips it — correctly,
  // there is nothing in a bucket to seal — and with `dataUrl` unlisted the FIELD
  // backfill ignored it too. The photograph stayed in the clear while both jobs
  // reported success, which is the one outcome worse than an error.
  'incidents/photos': {
    keyClass: GENERAL,
    fields: ['caption', 'name', 'dataUrl'],
    files: true,
  },

  // ── Injuries: a named colleague's clinical record ──────────────────────────
  // MEDICAL_FIELDS from src/modules/incidents/lib/injuries.js, plus the name.
  // `personId`, `incidentId` and `incidentRefNo` are joins and stay readable:
  // purgeIncidentMedicalRecords and the retention sweep both find records by
  // querying on them, and a record nothing can find is a record nothing can
  // delete when the law says it must be.
  injuries: {
    keyClass: MEDICAL,
    fields: [
      'bodyParts',
      'injuryType',
      'medication',
      'firstAidDetail',
      'daysToReturnToWork',
      'recordFileIds',
      'personName',
    ],
  },
  // The GP letter, the fit note, the discharge summary. `name` is on the list
  // because a filename is the record — "MRI-left-knee — A Kumar.pdf" needs no
  // opening — and `dataUrl` because under the inline fallback the pointer IS
  // the file.
  'injuries/records': {
    keyClass: MEDICAL,
    fields: ['name', 'caption', 'dataUrl'],
    files: true,
  },

  // ── Illnesses: occupational health ─────────────────────────────────────────
  illnesses: {
    keyClass: MEDICAL,
    fields: [
      'healthIssue',
      'affectedBodyParts',
      'exposedToAgent',
      'exposureDuration',
      'ppe',
      'createdByName',
      'affectedPersonnel[].name',
      'affectedPersonnel[].contact',
      'affectedPersonnel[].company',
      'affectedPersonnel[].dept',
      'actions[].description',
      'actions[].title',
      'actions[].owner',
      'actions[].ownerName',
    ],
  },
  // A GP letter or a fit note. Both the pointer and the BYTES are sealed.
  //
  // This comment used to say 'No `files: true`' — because sealing the object
  // would hand an <img> a URL pointing at ciphertext — and it sat directly above
  // an entry that sets it. That reason stopped being true when the decryption
  // moved into shared/storage/resolveFiles.js (see the note above the table):
  // the seam hands renderers a usable `.dataUrl`, so nothing downstream knows
  // or cares. A comment that contradicts the line under it is worse than no
  // comment, because it is the one a reader trusts.
  'illnesses/files': {
    keyClass: MEDICAL,
    fields: ['name', 'caption', 'dataUrl'],
    files: true,
  },

  // ── HSE committee meetings ─────────────────────────────────────────────────
  // Minutes name people and record what was said about them. `type`, `date`,
  // `siteId` and `docId` stay readable — the calendar and the site filter are
  // built on them.
  consultations: {
    keyClass: GENERAL,
    fields: [
      'subject',
      'minutes',
      'preRequisites',
      'createdBy',
      'attendees[].name',
      'attendees[].company',
      'attendees[].designation',
      'actions[].action',
      'actions[].owner',
    ],
  },

  // ── LOTO ───────────────────────────────────────────────────────────────────
  //
  // Per-job permits (modules/loto — organizations/{orgId}/lotoPermits). The
  // names of who asked, who approved, who did the work and whose lock is on
  // which point are personal data; so are the contractors, who are held ONLY as
  // text on the permit and have no account to hang a uid on. Free-text
  // justifications are sealed with them — they name people ("Ravi's lock",
  // "called X on the radio") the way incident narratives do.
  //
  // Left readable on purpose: the permit number, status, window, work type, the
  // site/region/entity (the mail scope and every filter), the procedure ids and
  // the lock NUMBERS. A padlock number identifies a padlock, not a person, and
  // the server needs it to explain a refused lock. Uids are join keys, as
  // everywhere else (requestedBy, personnelUids, approval.by).
  //
  // The scan and return maps are keyed by isolation-point key and hold only
  // times and uids, so there is nothing in them to seal — which is also why they
  // are maps: a path with a dynamic key cannot be written in this table.
  lotoPermits: {
    keyClass: GENERAL,
    fields: [
      'reason',
      'requestedByName',
      'internalPersonnel[].name',
      'vendorWorkers[].name',
      'vendorWorkers[].company',
      'vendorWorkers[].contact',
      'locks[].techName',
      'groupLock.members[].name',
      'lockPhoto.byName',
      'approval.byName',
      'approval.note',
      'approval.selfApprovalReason',
      'extensions[].reason',
      'extensions[].byName',
      'closure.byName',
      'closure.note',
      'emergency.byName',
      'emergency.reason',
    ],
  },
  'lotoPermits/events': {
    keyClass: GENERAL,
    fields: ['byName', 'note'],
  },
  'lotoPermits/attachments': {
    keyClass: GENERAL,
    fields: ['name', 'byName'],
  },
  // The authorised-technician register. Root collection tenanted by an orgId
  // FIELD (docs/LOTO-COLLECTIONS.md), not under organizations/{orgId}, so the
  // backfill reads it by that field (`root: true` on its TARGETS entry). This
  // was the known gap: a technician's name and phone/email sat in the clear
  // while the permit that now refers to them is sealed. The name copied onto a
  // procedure's lockState at lock time is a separate, still-open copy.
  technicians: {
    keyClass: GENERAL,
    fields: ['name', 'contact', 'licenceNo'],
  },

  // ── Mock drills / emergency response records ───────────────────────────────
  // `score`, `outcome`, `eventType`, `scenario` and the timing numbers stay
  // readable: the scorecard, the KPI roll-ups and the site filters group by
  // them, and none of them names anybody.
  mockDrills: {
    keyClass: GENERAL,
    fields: [
      'debrief',
      'commander',
      'commanders[]',
      'loggedBy',
      'actionLog[].action',
      'actionLog[].observation',
      'capa[].action',
      'capa[].owner',
      'capa[].department',
      'capa[].assignees[].name',
    ],
  },
  // Same as illnesses/files, and the same correction: getMockDrillPhotos
  // normalises onto `.dataUrl`, and resolveFiles decrypts at that seam — so the
  // recorder, the detail modal and the printed report render sealed objects
  // without knowing it. Both the pointer and the bytes are sealed.
  'mockDrills/photos': {
    keyClass: GENERAL,
    fields: ['dataUrl'],
    files: true,
  },
}

/** The policy for a collection path, or null when nothing there is sealed. */
export function policyFor(collection) {
  return POLICY[String(collection || '')] || null
}

/** Every collection this table covers — the backfill iterates it. */
export const SEALED_COLLECTIONS = Object.keys(POLICY)

/** Does this collection store encrypted file bytes as well as fields? */
export const sealsFiles = (collection) => Boolean(policyFor(collection)?.files)

/** The key class a collection's values are sealed under, or null. */
export const keyClassFor = (collection) => policyFor(collection)?.keyClass || null

// ── Walking a document ───────────────────────────────────────────────────────

/**
 * Returned from a transform to mean "drop this field entirely".
 *
 * Used for a value the reader is not entitled to. The alternative — leaving a
 * null, or the raw ciphertext — is worse in a way that is easy to miss:
 * `(injury.bodyParts || []).map(...)` throws on a null and prints an envelope
 * on a string, so an auditor opening an injury record would get a blank screen
 * or a page of base64 rather than a record with the clinical columns absent.
 * Deleting the key makes every existing `|| ''` and `|| []` in the renderers do
 * the right thing without one of them being edited.
 */
export const OMIT = Symbol('omit')

/**
 * A copy that can be edited without touching the caller's object.
 *
 * NOT structuredClone, and not JSON round-tripping. A Firestore document holds
 * Timestamp instances, and both of those either throw on them or flatten them
 * to plain objects — at which point `.toDate()` is gone, sixteen files that
 * read `.seconds` still work, and three sorts that compare `.seconds` silently
 * return 0 for every pair and leave the list in its original order. A list that
 * looks sorted and is not is the failure mode this avoids.
 *
 * So: plain objects and arrays are rebuilt, and anything with a prototype of
 * its own — Timestamp, Date, Blob, a FieldValue sentinel like serverTimestamp()
 * — is carried across by reference, untouched.
 */
export function cloneForEdit(value) {
  if (Array.isArray(value)) return value.map(cloneForEdit)
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto === Object.prototype || proto === null) {
      const out = {}
      for (const k of Object.keys(value)) out[k] = cloneForEdit(value[k])
      return out
    }
  }
  return value
}

/**
 * Every place a path spec lands, as `{ parent, key }` pairs.
 *
 * Missing intermediate objects and missing keys are skipped rather than
 * created: a policy naming `horizontal.details` must not add a `horizontal` to
 * a document that has none, or every save would grow the document with empty
 * scaffolding for fields nobody filled in.
 */
export function leafRefs(root, spec) {
  const parts = String(spec).split('.')
  let nodes = [root]
  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i]
    const isArray = raw.endsWith('[]')
    const name = isArray ? raw.slice(0, -2) : raw
    const last = i === parts.length - 1
    const next = []
    for (const node of nodes) {
      if (node == null || typeof node !== 'object') continue
      if (name && !(name in node)) continue
      const child = name ? node[name] : node
      if (isArray) {
        if (!Array.isArray(child)) continue
        for (let j = 0; j < child.length; j += 1) {
          if (last) next.push({ parent: child, key: j })
          else next.push(child[j])
        }
      } else if (last) {
        next.push({ parent: node, key: name })
      } else {
        next.push(child)
      }
    }
    nodes = next
  }
  return nodes
}

/**
 * Apply `fn(fieldPath, value)` at every path a collection's policy names.
 *
 * Returns a NEW document; the input is not modified. `fn` may return OMIT to
 * have the field removed. Order is not significant and every value is
 * transformed concurrently — sealing forty fields one await at a time is forty
 * round trips through the crypto engine on the main thread.
 */
export async function mapSealed(collection, doc, fn) {
  const policy = policyFor(collection)
  if (!policy || doc == null || typeof doc !== 'object') return doc

  const copy = cloneForEdit(doc)
  const jobs = []
  for (const spec of policy.fields || []) {
    for (const ref of leafRefs(copy, spec)) {
      jobs.push(
        Promise.resolve(fn(spec, ref.parent[ref.key])).then((next) => {
          if (next === OMIT) {
            // Splicing an array here would shift every later index while other
            // jobs still hold one. Arrays get undefined and are compacted below.
            if (Array.isArray(ref.parent)) ref.parent[ref.key] = undefined
            else delete ref.parent[ref.key]
          } else {
            ref.parent[ref.key] = next
          }
        }),
      )
    }
  }
  await Promise.all(jobs)
  return compact(copy)
}

/** Drop the holes OMIT left in arrays, after every job has finished. */
function compact(value) {
  if (Array.isArray(value)) return value.filter((v) => v !== undefined).map(compact)
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const k of Object.keys(value)) value[k] = compact(value[k])
  }
  return value
}
