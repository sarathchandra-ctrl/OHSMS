# LOTO permits

A per-job permit on top of the isolation procedures in `src/modules/loto`. The
procedure says *how* to isolate a machine and is approved once; the permit says
*this crew isolates it, for this job, in this shift window*. Controlling
standard cited on screens and printouts: **OSHA 29 CFR 1910.147**.

## Terminology

Shared with the standalone [hecp-loto](https://github.com/sarath200795/hecp-loto)
app, and pinned in `src/modules/loto/constants/terminology.js`:

| Thing | Name used here | Not used |
| --- | --- | --- |
| The person who applies a lock | **Technician** | the HYD8 job-title abbreviation |
| The per-job record | **permit** | calling that record "a LOTO" |
| The isolation instruction | LOTO procedure | — |

Procedure statuses stay `draft`, `pending_approval`, `approved`, `rejected`.
Equipment lock state stays `unlocked`, `partial`, `locked`. Isolation points
are numbered `E-`, `M-`, `H-`, `P-`, `C-`, `G-`. Devices, personal and
department lock types, the `groupLock` shape and the device-count tally are
the hecp-loto ones (`group_loto_box` included).

## Where it lives

`lotoPermits/{permitNo}`. One installation is one organization, so there is
no tenant in the path (`AGENTS.md`).

Subcollections: `events` (append-only history), `attachments` (create-only).

## Permit number

`LP-<UTC year>-<NNNN>`, one sequence per org per year. The number is the document
id. The counter is `docSeq/lotoPermit-<year>` (`{ n }`). The app bumps it in
**the same transaction** that creates the permit, and the server lets a
counter only move forward (`stack/policy.mjs`).

## Status machine

```
requested ──► approved ──► active ──► returned
    │            │           └──────► emergency_removed
    ├──► rejected└──► withdrawn
    └──► withdrawn
```

`returned`, `rejected`, `withdrawn` and `emergency_removed` are closed: a closed
permit does not reopen. The table lives in `constants/permits.js` (drives the
buttons) and `stack/policy.mjs` (`LOTO_TRANSITIONS` with who may make each
move — the one that cannot be bypassed); a parity test keeps them identical.

## Shift window

The window is a shift. Start and end are not typed. Defaults, until an Admin
saves clocks for a site at `/loto/shifts` (`lotoSettings/shifts`, writable by
managers and admins):

| Id | Clock |
| --- | --- |
| A | 06:00–14:00 |
| B | 14:00–22:00 |
| C | 22:00–06:00 (next day) |
| general | 09:00–18:00 |

A request can be raised from **30 minutes before** the shift starts until it
ends. The server (`lotoWindowProblem` in `stack/policy.mjs`) checks that lead
and, for a default shift, the length (8 hours, or 9 for general). Once a site
is saved, it checks the hour and minute against that site's clocks in the zone
the Admin stored (minutes east of UTC). Only an Admin may extend past the shift end. The
extension appends one record — who, when, the previous end, the new end, and a
reason — and that list is the extension history.

## Who may do what

| Action | Who |
| --- | --- |
| Raise | any approved, non-auditor member |
| Withdraw (before work starts) | the requester, or an Admin |
| Approve / reject | Admin of the permit's site or entity (`lotoPermitAdminOf`). An Admin with no site and no grant still reaches every permit. Nobody named on the permit, and nobody who raised it, may approve it. The raiser may self-approve only by recording that no other administrator could. |
| Extend / emergency removal | That same Admin. Emergency removal is not blocked by being named on the permit; the attestations stay. |
| LOTO procedure approval | Admin or Safety (platform manager). Unchanged. |
| Start isolation / return | the requester, a named internal person, or an Admin |

An Admin with an empty site and no access grant still reaches every permit.
An Admin posted to a site, or granted sites or entities, reaches a permit only
when that site or that entity is the permit's. A region grant is not enough.
Self-approval is refused unless the approver records that there was no other
administrator (`approval.selfApproved` + `selfApprovalReason`). Someone named
on the crew cannot approve, even with that reason.

## Equipment

Every permit names a piece of equipment and an **approved** procedure of that
equipment. The work type "Other (area / tag-only)" is gone: the form refuses
`workType == 'other'` and a permit whose procedure is not approved or not that
equipment. The form
warns, and does not hide the field, when that equipment is already locked or
held by another permit. Start is still what refuses a second isolation of a
procedure a permit already holds.

## Procedure ↔ permit consistency

While a permit is `active`, its procedure carries `activePermit: { id, permitNo }`.
The app sets and clears the marker **only in the same transaction** as the
permit becoming `active` / closing (`services/permitActions.js`).

## Personal data

`reason`, every name on the permit (requester, approver, internal personnel,
contractors, lock holders) and free-text notes are sealed
(`src/shared/crypto/policy.js`: `lotoPermits`, `lotoPermits/events`,
`lotoPermits/attachments`). Uids, lock numbers, status, window, scope fields and
procedure ids stay readable: they are join keys, mail scope and filters.

The authorised-technician register (`technicians`: name, contact) is now sealed
too and is covered by the backfill (`root: true` target). The technician name
copied onto a procedure's `lockState` at lock time is a separate, still-open
copy.

Subject-access export / erasure: `stack/lib/subjectData.js` lists permits (by
`requestedBy` and by `personnelUids`), their events/attachments, technicians and
locks.

## Mail (PR C)

**Not running on the current server.** On Firebase this was a trigger
(`notifyLotoPermitLifecycle`) and it has not been ported; no LOTO mail is sent
today. As built, it mailed on:
requested, approved, rejected, extended, returned, emergency removal, due,
overdue (repeats every 30 min; worded as an escalation from the 3rd notice).
Withdrawn and the start of isolation are not mailed.

Recipients on every event: the requester, the approver / remover / returner,
internal personnel (by uid), and the scoped audience from `audience.js`
(org admins + members whose site / region / entity grant reaches the permit).
Contractors are text only and have no mailbox. Delivery reuses `circulate`
(ledger key `lotoPermit/<org>/<permit>/<event token>/<uid>`, Brevo pacing, cap,
retry-safe) and the shared mail layout, with the organisation's name as sender.
Nothing sealed is read: the mail carries permit number, work type, equipment,
site, window (printed in IST) and status, and the actor's name from their
profile; the job description, names on the permit and the emergency reason stay
in the app.

## Due / overdue (PR C)

`sweepLotoPermits` is a server job (`stack/workers.mjs`) that writes
`flags` (`windowEnd`, `dueAt`, `overdueCount`, `overdueSince`, `lastOverdueAt`)
onto **active** permits only. Flags are keyed to the window end they were
computed for, so an extension restarts the count. A window is two absolute
instants, so a shift crossing midnight needs no special case. The app's badge
uses the browser clock and defers to the server flags in the escalating
direction. On Firebase it ran every 5 minutes; the current server has no
scheduler, so it runs when an admin calls it.

## Retention

Closed permits (returned, rejected, withdrawn, emergency removal) are meant to
be kept **1 year** from `closedAt` and then purged with their events,
attachments and stored files. On Firebase that was a nightly sweep
(`purgeClosedLotoPermits`); it has not been ported to the current server, so
closed permits are kept until it is. Open permits are never purged.

## Tags and the public procedure page

Each isolation point prints as a colour-coded energy tag: Electrical red `E-`,
Mechanical blue `M-`, Hydraulic green `H-`, Pneumatic orange `P-`, Chemical
yellow `C-`, Gravitational purple `G-`. The band reads DANGER · DO NOT OPERATE.
The QR on the tag is that point (`/t/<procedureId>/<pointKey>`), and Start is
refused until every point key has been scanned. A code that only carries the
printed id (`E-1`) does not count.

`/p/<id>` stays the public read-only procedure page. It is a different QR from
the tag: the procedure page says how to isolate the machine; the tag says
whether this point is isolated now.

## Import and learn

Import (`/loto/import`) takes CSV for equipment, locks, group numbers and
technicians, and offers a template for each. Examples in the templates are
invented. Equipment rows become draft procedures, so they still need approval
before a permit can use them. Group numbers still require an Admin. Learn
(`/loto/learn`) is a short explanation and a four-question check.

## Dashboard

The permit list shows the last seven days as the share closed on time, closed
late, and closed by emergency removal, plus how many closed today and how many
locks are issued out of the register. An overdue banner and an
approvals-waiting line stay on the page. A tone plays and, if the browser has
already been allowed, a desktop notification is raised. The activity page
filters the log. Export CSV writes the permits in the current filter. All of
these read only what is still stored; the one-year purge has already removed
the rest, so they cannot show it.

## Lock register

Each department lock can carry a tag number, a colour, and a service status
(`available`, `issued`, `out_of_service`), plus a history list and a use count.
Only an Admin may change those fields. Trace (`/loto/trace`) accepts a lock
number, a tag number or equipment and shows who holds it now and every permit
it has been on. The same page lists integrity problems: an issued lock must be
on exactly one open permit, and an out-of-service lock must not be on one.
Use count on that page is the number of permits that named the lock, including
ones still inside the one-year retention window. Purged permits are gone, so
they are not in the count.

## Wireman licence

Every technician has a licence number (sealed), an expiry and an optional photo.
A permit that names that technician — a lock whose `techId` is set — is refused
unless `licenceExp` is still in the future. The form checks this. Department locks
have no `techId` and are not a person. Only an Admin may write the licence fields.

A contractor confirms competence (`competent: true`) and may attach a
certificate photo (`certificatePath`). Their contact must not be an email
address. Mail stays with internal staff.

## Before Start

Two things are required before Start, and the app refuses the start without them:

1. A zero-energy try-out. **Yes** is required. **No** blocks Start.
2. A live camera photo of the lock with the tag on it. There is no gallery upload. The picture is stamped with the time, the person, the permit number and the equipment, stored as a `procedurePhotos` document (`permitlock_<permitNo>`, the same collection as procedure photos) and named on the permit as `lockPhoto`. The nightly purge deletes that file with the permit. An Admin can request a new photo (`photoRedo`); Start is refused until the photo is newer than that request.

## Group lockout

A permit may carry hecp-loto's `groupLock`: `method` `box` or `hasp`, `members[]`
with one personal lock each, and `primaryUid` equal to the first member. Device
count is one safety padlock per member, plus a group lock box, or a hasp when
more than one lock is stacked.

The number comes from `lotoGroupNumbers/{no}`, which an
Admin registers empty. Raising the permit sets `openPermitId` in the same
commit. Each member removes only their own lock (`removedUids`). The primary
cannot come off until the others have, and the return that takes the primary
off closes the permit and frees the number. Withdraw, reject, return and
emergency removal clear `openPermitId` in that same commit.

## Working a permit (PR B)

1. **Approve / reject** — Admin of the permit's site or entity. Rejecting needs a
   reason. An administrator's own request goes to another administrator who
   reaches that permit; self-approval is offered only when no other such
   administrator exists, and stores its reason. A person named on the permit
   cannot approve it.
2. **Isolate** — the crew applies the lock at each point and scans the tag QR
   there (`/t/<procedureId>/<pointKey>`). Camera scanning uses the browser's
   `BarcodeDetector` (no library); a typed link / point key / point number
   (`E-1`) is the fallback. A tag from other equipment never counts. **Start**
   is possible only when every point has been scanned.
3. **Start = one transaction** (`services/permitActions.js` `startIsolation`):
   permit → `active`, every point locked, procedure stamped `activePermit`,
   `procedureQr` mirror rewritten, `lockClaims` taken (global padlock
   uniqueness: the server will not move a held claim to another procedure),
   `lotoEvents` appended (append-only on the server, in the writer's own name),
   permit timeline entry. All or nothing.
4. **Return = one transaction** — pre-energise checklist (4 items) and each lock
   confirmed individually; all points unlocked, marker cleared, claims released,
   permit `returned`.
5. **Emergency removal** — Admin; reason + 3 attestations; same release, permit
   `emergency_removed`.
6. **Extend** — Admin; later end only, ≤ 24 h per extension, reason recorded.
7. While a permit is active the procedure's own Lock/Unlock, group-lock,
   revise, re-approve and delete are refused by the app; approving a procedure
   is a manager's decision on the server.

## Printout, Excel and dashboard (PR D)

- **Permit PDF** (`utils/permitPdf.js`, "Download PDF" on a permit): job, window,
  who requested / approved (self-approval is marked with its reason), personnel
  and contractors, each isolation point with its lock, who owns it and when and
  how its tag was scanned, extensions, the pre-energise checklist and return, or
  the emergency removal with its reason and attestations. The header and the
  declaration cite OSHA 29 CFR 1910.147. The QR encodes the link to the permit
  (`/loto/permits/<no>`), never its contents, so an old printout shows live status.
- **Excel** (`utils/permitExcel.js`, "Export Excel" on the list): the permits in
  the current filter as a workbook with **Permits** (one row each) and
  **Isolation points** (one row per point: lock, scan time and method, lock
  removed). Text typed by people is prefixed against formula injection exactly as
  the CSV exports do. The export contains names; it is a read the viewer is
  already entitled to make, loaded only when clicked (the `xlsx` chunk is lazy).
- **Dashboard** (`components/permits/PermitDashboard.jsx`): Open, Overdue, Due
  soon and Closed counts above the list; each tile applies the matching filter.
  Overdue / due use the same clock as the row badges (server flags first), and a
  closed permit is never overdue.
- `utils/permitExport.js` holds the one flattened `permitSummary` all three read,
  so what is printed, exported and counted cannot drift apart.

