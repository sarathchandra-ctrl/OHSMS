# Data subject rights

What this system can answer when a person asks to see, or to delete, what is
held about them — and, just as importantly, what it cannot.

This app stores occupational-health data: injuries, illnesses, medical
restrictions, GP letters, fit notes. Under GDPR and India's DPDP Act 2023 that
is sensitive personal data, and both give the subject rights over it.

**Status: access is implemented. Erasure is classified but not executed.** The
reason for the split is in §3, and it is a legal decision rather than an
engineering one.

---

## 1. Where a person's data actually is

`stack/lib/subjectData.js` is the inventory, and it is the foundation of
everything else here. It exists because neither question — "show me my data",
"delete my data" — can be answered without first knowing every place the data
is, and this system denormalises people heavily.

A person appears in **two fundamentally different ways**, and only one of them
can be found by a query:

| | How | Completeness |
|---|---|---|
| **Joined** | A structural key names them: `personId` on an injury, `employeeUid` on a training record, `actorUid` in the audit log, the uid on their own profile. | **Complete.** Indexed, exact, every record found. |
| **Mentioned** | Their *name* is free text inside an object in an array: `affectedPersonnel[].name`, `attendees[].name`, `commanders[]`, `capa[].owner`. | **Not searched.** A name inside free text is not a key, and with encryption on it is ciphertext (§2). |

The export returns these separately and never merges them. That is deliberate:
a response that silently omitted the committee minutes naming someone is a
*failed* subject access response, not a partial one, and the only way to avoid
claiming completeness it does not have is to say where it stopped.

### WhatsApp site lookup

The WhatsApp lookup (`docs/WHATSAPP.md`) adds the personal-data
collections below. Its server half has not been carried over from the Cloud
Functions tier, so the feature is switched off (`src/shared/serverFeatures.js`)
and nothing writes these today; the export still looks for them:

| Collection | What | Reached by | Kept |
|---|---|---|---|
| `waLinks` | The person's WhatsApp number (the document id) and the uid it was proven for, or attached by an organisation administrator | `uid` | Until they unlink (UNLINK / STOP on WhatsApp, Security → Unlink, or an administrator removes it in Org Settings), or erasure |
| `waQueryLog` | Which site they looked up, when, and the outcome. The number only as a keyed digest; **no message text** | `uid` | 90 days (`purgeWhatsAppLedgers`) |
| `waSessions` | Chosen organisation, the last pick-list of site or organisation ids, and (for 15 minutes) the one site id the audit question is about. Never a location, never the message text. A row with no uid is not included in that person's export. | `uid` | 24 hours idle (`purgeWhatsAppLedgers`), or erasure. Numbered choices and the audit question stop working after 15 minutes. |

All three are in `SUBJECT_SOURCES` as `topLevel` + `orgField`, so the export finds
them by uid without crossing tenants, and all three are ERASABLE. Withdrawing consent
deletes the link immediately. Organisation administrators of that tenant can also see
the numbers linked to their own organisation, through the `whatsAppOrgStatus`
callable — not by reading the collection. The sender's WhatsApp profile name arrives in
every webhook and is dropped on receipt. The site summary carries counts only — never an
incident narrative, a name from an action, or anything medical; illness actions
are excluded from the action count altogether, because at a small site a count
can point at one person's health. If the caller asks, a second message adds the
cached last-audit date, day-0 and N+7 scores, and open-point labels with
their ticket status (the same warehouse text the ODIN dashboard shows to
someone who can already see that site) and when that extract was taken. That cache is `siteAuditCache/{orgId}/sites/{siteId}`:
server-only in the rules, overwritten in place, keyed by the site rather than
a person, so it is not a subject-access source and it is not sealed. Messages
pass through Meta (WhatsApp Cloud API) as a processor; record it in the ROPA
and the DPA.

## 2. Subject access (implemented)

**Admin → Maintenance → Subject access request.** Choose the person (and
their injury person id, if they have one), press Gather, download the JSON.
The export is written to the audit log.

Server-side it is the `exportSubjectData` job (`exportSubject` in
`stack/workers.mjs`), planned by `stack/lib/subjectData.js`:

- **Manager-only.** The same standing `stack/policy.mjs` requires to read
  `injuries` and `illnesses`, judged on the caller's live profile. Anything
  less would let an employee assemble a colleague's medical history in a
  single call — a bulk export concentrates data in a way the individual
  screens do not.
- **Checked against the subject's own profile.** The uid must be a person in
  this installation, and both ids are validated before anything is read.
- **Sealed values stay sealed.** The server returns what is stored; with
  encryption on, the requesting manager's browser holds the keys.
- **Reports its own failures.** A collection that cannot be read appears in
  `problems` rather than being quietly absent.

### The trap this design is built around

Every scannable field is also a field `src/shared/crypto/policy.js` **seals** —
names are personal data, so of course it does. Join keys are deliberately left
readable so queries keep working.

So the moment `VITE_ENCRYPTION=on` and the backfill has run, a server-side scan
for a name reads ciphertext and finds nothing. **Zero matches is
indistinguishable from a person who is genuinely not mentioned.** That is a
silent wrong answer to a legal request.

`scanFeasibility()` exists to say so out loud, and the UI surfaces it. Once
encryption is on, the mentions half has to be done in the browser of somebody
entitled to the keys, or recorded as not performed. It must never be reported as
"none found".

## 3. Erasure (classified, not executed)

The export returns a classification of every source into three buckets. Nothing
deletes anything yet, and that is the correct state until somebody with legal
authority signs off the table.

| Bucket | Meaning | Examples |
|---|---|---|
| **Refused — statutory** | OHS law requires retention; the right to erasure does not reach it (GDPR Art. 17(3)(b), DPDP s.17(1)). | `injuries`, `illnesses`, `incidents`, `consultations`, `trainingRecords`, `auditLogs` |
| **Anonymise** | The record must survive for aggregate safety reporting but need not name anybody. | `users`, `mockDrills` |
| **Erasable** | No safety evidence once resolved. | `trainingRequests`, `trainingAssignments`, `erpContacts` |

**The refusal is a deliverable, not a failure.** In an occupational-health
system the honest answer to "delete everything about me" is mostly "most of this
cannot be deleted, and here is each part and why". Every entry in the table
carries a `why` written to be sent to the person asking.

And the refusal usually protects *them*: an injury record is the worker's own
evidence of what happened to them at work. Deleting it on request destroys the
thing they would need to prove a claim years later.

### ⚠️ Before erasure is built, someone with legal authority must fix the table

The retention classes in `subjectData.js` are an **engineering reading of the
law, not advice**. Jurisdiction changes them, and this app is multi-tenant, so
different tenants may sit under different regimes. Specifically:

- Exposure and health-surveillance records carry the longest statutory periods
  and the exact number varies by jurisdiction and by agent.
- A period table now exists (`stack/lib/retentionPolicy.js`) but every
  personal-data row is `NEEDS_LEGAL_SIGN_OFF`. A record classed `STATUTORY` is
  currently kept forever, which is itself a data-protection finding: indefinite
  retention is not lawful merely because some retention is. Counsel must sign
  `counselSignOffQuestions()` before any live age-purge is enabled.
- `auditLogs` is append-only in the rules by design. Erasing from it is not
  currently possible even if it were decided to be lawful.

### The specific decision now waiting on you: how long an injury report is kept

An ISO 27001 audit (A.8.10) found `/injuries` had no deletion path of any kind —
`deletedAt` was written as null and read by the list filter, and nothing ever set
it, so the only home of a named colleague's clinical detail and of the GP letters
and fit notes in its `records` subcollection was the one collection in this app
whose contents could not be removed by any route the product offered. Comments in
four other files referred to a `purgeIncidentMedicalRecords` that has never
existed.

**That half is now built**: `deleteInjury` / `restoreInjury` / `purgeInjury`
(`src/modules/incidents/lib/injuries.js`), the Recycle Bin shows injury reports,
and `stack/lib/retention.js` purges them thirty days after deletion together
with the `records` subcollection and the Storage objects behind it. Only managers
can write `deletedAt` on an injury — injuries are readable, and so writable,
by managers alone (`stack/policy.mjs`) — because it schedules an irreversible
deletion rather than hiding a row.

**What is deliberately NOT built is a maximum age.** An injury nobody deletes is
kept indefinitely, exactly as before, and that is this section's general finding
narrowed to the sharpest case. Two decisions are needed, and both are legal
rather than engineering:

1. **The period.** How long after the injury date must an injury report be kept,
   and may it then be destroyed? Occupational injury records carry a statutory
   minimum in most jurisdictions, and this app is multi-tenant, so tenants may
   sit under different regimes.
2. **Whether it is per-tenant.** If the answer differs by jurisdiction, the
   period belongs on the organization document rather than in the code.

When answered, the change is small and the place is already prepared:
`planPurge()` in `stack/lib/retention.js` takes `days` per call, so enforcing
a period is a `days` on the `injuries` entry in `PURGEABLE` plus one line in
`purgeOrgCollection`, which currently passes the shared 30-day constant.
`retention.test.js` asserts the absence of that field today, so adding one is a
deliberate act that turns a test red rather than a quiet default.

**Related decision, also open:** purging an *incident* does not touch the injury
reports derived from it. That is intentional — an injury is a record in its own
right, and destroying occupational health records nobody asked to delete is the
direction that can hurt someone — and it is pinned by a test. It does mean an
injury can outlive its parent incident and hold a `incidentRefNo` that no longer
resolves. If the retention answer above is "injuries die with their incident",
that test is where to start.

## 4. What is NOT built

- **Execution of erasure.** Classification only. See the warning above.
- **Retention periods.** Only the Recycle Bin's 30-day purge exists
  (`stack/lib/retention.js`), and it now covers `injuries` and their
  clinical documents as well as incidents and illnesses. Live records still have
  no expiry — see the injury-retention decision in §3, which is the sharpest
  case of exactly this gap. The period table that was missing is now
  `stack/lib/retentionPolicy.js`: every personal-data class is marked
  `NEEDS_LEGAL_SIGN_OFF`, live age-purge is off, and `counselSignOffQuestions()`
  is the list counsel must actually answer. A number in that file is a
  proposal, not a rule.
- **The mentions scan.** The places are named; nothing searches them.
- **Self-service.** A subject cannot make the request themselves; a manager runs
  it for them. Reasonable while volumes are low, and it should be revisited if
  they are not.

## 5. Keeping the inventory honest

`SUBJECT_SOURCES` and `POLICY` describe the same personal data for different
purposes, and they live in **different npm packages**, so no import can tie them
together. A collection added to one and not the other is a silent gap — in
`policy.js` it means storing a name in the clear, in `subjectData.js` it means
leaving a person's data out of their own export.

`EXPECTED_SEALED` in `subjectData.js` is checked by the test suite for exactly
this. When you add a collection that holds personal data, update both, or the
test tells you which one you forgot.
