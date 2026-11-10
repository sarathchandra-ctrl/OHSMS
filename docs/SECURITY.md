# Security register

Every security defect found in this codebase, what was done about it, and what
is still open. Kept beside the code so a finding cannot quietly become folklore.

**How to read severity.** It is about what an attacker actually gets, not how
alarming the mechanism sounds. A cross-tenant data leak and a missing size cap
are not the same thing even when both are "a rules bug".

**The one structural fact behind most of this.** Every read and write goes to
the organization's own server, where `stack/engine.mjs` asks
`stack/policy.mjs` before touching the database. That policy is the only
enforcement that cannot be bypassed. Anything enforced in React — `can()`, a
hidden button, a disabled field — is a usability feature, not a control. Every
entry below marked *"enforced only in React"* means exactly that: the same
action succeeds from the browser console.

The older entries were found and fixed when the app ran on Firebase, where
`firestore.rules` and `storage.rules` played that part; they are written up as
they were. When the app moved to its own server, each of those protections was
re-checked against `stack/policy.mjs`, and the ones that had not come across
were restored with tests.

Two failure patterns account for most of the list, and both are worth
recognising on sight:

1. **The permissive union.** Allows OR together. A narrow rule that refuses
   something is worthless if a broader one grants it. Found three times here.
   In `stack/policy.mjs`, restrictions live in `restrictWrite`, which every
   write passes in addition to an allow.
2. **The post-state branch.** On an update, the new value (`next`) is what the
   writer sent. A rule that authorises against it lets the writer supply the
   value that authorises them. Found three times here. Decisions about
   privilege read the stored profile and `prev`.

---

## Open findings are not in this file

**This register is the CLOSED half only.** The open entries — findings that are
live, or accepted with a residual risk — were moved out of this repository on
2026-09-10 and are held privately by the maintainer.

This repository is public. A closed finding written up with its mechanism, its
fix and its test is a credential: it shows the defect was found, understood and
proven closed, and publishing it costs nothing because there is nothing left to
exploit. An **open** finding written up to the same standard is a different
document — it names a live weakness, its reachability, and where in the source
to look. An ISO 27001 audit (2026-09-09, finding H-2 under A.5.12 / A.8.4)
raised that both halves were being served to anyone who asked, and that the
second half was almost certainly not a decision anyone had made.

So the split is now explicit, and the rule for anything added here is:

> A finding goes in this file when it is closed. While it is open it lives in
> the private register, however well written up it is. If you are unsure whether
> something is exploitable as described, that uncertainty means private.

Ask the maintainer (see the root `SECURITY.md` for how to make contact) if you
need the open register — for a security review, a due-diligence request, or a
disclosure you are checking against what is already known.

Note that git history still holds the open entries as they stood before this
split, and rewriting it was considered and rejected: it would change every
commit SHA and orphan the `v*` release tags that tie each deployment to a
commit, which is a traceability control this project actively relies on.
Treating that history as public is the safer assumption, so the entries moved
out are being worked rather than merely hidden.

## Recently closed

### S-28 · Metabase URL check missed two literal forms, and followed redirects — CLOSED

`checkBaseUrl` is what stops an organisation admin's Metabase setting from
becoming a URL the Cloud Function dials on a private network. The dotted
patterns and the hostname set did that for the forms a person pastes. Two
forms the URL parser accepts were not in either list:

- a trailing dot, which DNS treats as the same name (`metadata.google.internal.`)
- an IPv6 literal, including the IPv4-mapped spelling Node gives the metadata
  address

`fetch` also follows redirects. The host check ran on the URL that was saved,
and a 302 is a different host, carrying the API key in `x-api-key`.

The host check now strips a trailing dot and refuses every IPv6 literal —
Metabase is configured by hostname, and no instance URL is one. Before the
request, the hostname is resolved (the OS lookup and the A and AAAA records)
and any private, loopback, link-local, metadata, or non-global address
refuses the whole host, including an IPv4 carried inside an IPv6 form. The
socket lookup returns only the addresses that passed, so a later answer for
the same name is not what gets dialled. A 3xx fails the request and is not
followed, and the API key stays in the `x-api-key` header.
`stack/lib/metabase.test.js` covers the literal forms, the resolved
addresses, the pinned lookup, and the refused redirect.

### S-27 · A LOTO procedure mirror could carry the names it exists to hide — CLOSED

`/procedureQr/{id}` is world-readable by `get`, and the id is the one printed
on the machine. The mirror exists because rules cannot hide fields, so the
procedure document — `primaryTech`, `createdByName`, the lock holder's name —
must never be that public page.

`publicProcedure()` whitelists the fields. The rule did not. `setDoc` of the
procedure onto the mirror path succeeded for any writer of the owning org,
and the client whitelist is not a control. `/qr` and `/permitQr` already pin
`keys().hasOnly` for the same reason; this match was the one that did not.

Create now requires `procedureMirrorFields()`, the same list the builder
writes, including `updatedAt`. Update uses `keepsMirrorShape`, so a mirror
that already holds a retired key can still be corrected and a new key is
refused. Nested fields are pinned too: each point may only carry the keys
`publicPoint()` writes, string fields are length-capped, `devices` is a short
list of strings, and the counts are integers bounded by that list.
`tests/publicProcedure.rules.test.js` sends the name fields at the top level
and inside a point, and the shape the public page is built from.

### S-26 · Uploads minted a permanent download URL — CLOSED

`getDownloadURL()` ran after every upload and the result was persisted on the
Firestore pointer. That string is not a link, it is a **bearer credential**: it
works for anyone holding it, signed in or not, forever, and no rule is ever
consulted. It sat in a document readable by every member of the tenant and by
the external auditor, it kept working after they left, and it survived any rules
change made afterwards.

The read path had already been migrated — `fileUrl` prefers an authenticated
`getBlob` that `storage.rules` governs, and the comment explaining why has been
in `adapters/firebase.js` for months. The **write** path was never changed, so
the app went on manufacturing one of these for every upload and filing it away,
while the reader carefully avoided using it. A URL that is never read is still a
credential once it is written down.

`adapters/firebase.js` no longer mints one. What that cost, and why it was more
than a one-line change: every renderer that read the stored url directly had to
resolve by `path` instead — `useFileUrl` and `StoredImage` are the two shapes
needed (a hook cannot be called inside a `.map()`), and the LOTO photo map
resolves at its own seam so neither the operate view nor the procedure PDF
changed. Records written before this keep rendering: `fileUrl` still falls back
to the stored url when there is no path.

**Not closed by this: the tokens already written down.** Every URL minted before
this change still works. Revoking them means stripping the
`firebaseStorageDownloadTokens` metadata from each object, and doing that blind
would permanently break any pointer that has a url and no `path` — records from
before uploads recorded one. The inventory is `scripts/inventory-download-tokens.mjs`:
dry-run by default, `--apply` only strips tokens on pointers that already have
a path, and url-only rows are listed for a person. Against a live project
`--apply` also needs `CONFIRM_REVOKE=yes`. The operator runbook is
`docs/LEGACY-DOWNLOAD-URLS.md`. Running it against production is an operator
decision, not a deploy step.

**Superseded on the current server (2026-11-10).** After the move off
Firebase, the server's own download links had again been minted without an
expiry and stored on records. Links now carry an expiry and are refused after
it (one to two hours, rounded to the hour so a file keeps one link within the
hour), links minted before that are refused outright, and records are sent
out with freshly signed links for the reader who has just passed the access
rules for them (`stack/blobSign.mjs`, `stack/lib/fileLinks.js`; tests in
`worker/server.test.js` and `src/shared/data/server.test.js`). Files still on
Firebase Storage are copied here and their links replaced by Admin →
Maintenance → "Move old files off Firebase Storage".

### S-25 · Uploaded files are not scanned for malware — MEDIUM, mitigated and accepted

Members upload photographs, PDFs, Office documents and video into a shared
tenant store and colleagues download them, which makes this app a distribution
path between employees. Nothing scanned any of it (A.8.7).

**What is now in place.** `storage.rules` already allow-listed content types,
refused SVG, forbade overwrites and capped size — that closes the
hosted-phishing-page vector, which is the highest-value one on a Google-owned
domain. What it could not do is tell whether a file IS what it claims: the rule
constrains `request.resource.contentType`, and that value is supplied by the
client. An `.exe` named `report.pdf` satisfied every check the system had.

`src/shared/storage/sniffType.js` now reads the first 64 bytes at upload and
refuses two things: a known executable header whatever it claims to be, and a
declared type the bytes actively contradict. It runs **before** the adapter is
loaded and **before** sealing, and both orderings are the control rather than
tidiness — after the adapter guard it would be skipped exactly when the bucket
is unconfigured and the caller falls back to writing the bytes into Firestore,
and after sealing there are no plaintext bytes left for anything to read, ever.
The refusal is its own error type so it cannot be mistaken for "storage is
unavailable, use the inline path".

**What is accepted, and why.** This is not malware detection and does not claim
to be — a genuine PDF carrying a malicious payload passes, and there is a test
asserting that so nobody mistakes the check for more than it is.

A real scanner is not a small step from here:

- It needs infrastructure this project does not have — ClamAV on Cloud Run — or
  a third-party API, and sending occupational health records, GP letters and fit
  notes to a scanning vendor is a **worse** privacy outcome than not scanning.
  It would make that vendor a subprocessor of medical data, which is a DPA and a
  register entry before it is a line of code.
- It cannot work at all where it matters most. Files in the sealed collections
  are AES-GCM ciphertext at rest; there is nothing for any scanner to read. The
  comment in `storage/index.js` has always said the octet-stream declaration
  exists so that "a browser, a thumbnailer, **a virus scanner**" does not try to
  interpret ciphertext — the impossibility was written down long before it was
  assessed.

**What would close it:** an owner-signed choice of the two options in
`docs/ADR-0001-malware-scanning.md` (in-project scanner over the *unsealed*
prefixes only, or a written exclusion of sealed medical documents plus a
subprocessor if a vendor is chosen), plus the matching function or exclusion
text. Until one of those is chosen this is a residual risk somebody has looked
at rather than a gap nobody noticed. Hygiene pins that this repository does
not grow a ClamAV / scanning-vendor package by accident.

### S-04 · Unbounded collection listeners — CLOSED

Every live collection listener in the app is now capped at
`COLLECTION_READ_CAP`, and every screen that totals one renders
`<IncompleteNotice>` when the cap is reached.

The shared seam — `subscribeCollections`, `subscribeOrgCollection`,
`incompleteReadNotice` — already existed and was already honest. What was left
was **adoption**, and the gaps were exactly where they hurt most:

- **`objectives` threw the signal away.** `ObjectivesContext` destructured
  `{ rows }` from `subscribeOrgCollection` and dropped `status`, so the KPI
  scorecard — the one screen whose numbers get quoted upward — reported a capped
  count as a real one.
- **The fire module capped SILENTLY, at five different ceilings.** Reports and
  mock drills at 1 000; signage, AEDs and FAS at 2 000; extinguishers at 2 000
  with a banner. So the dashboard said "the most recent 2 000 extinguishers"
  while the four other registers on the same page were being truncated with no
  mention — a caveat naming one of five short numbers reads as an assurance
  about the other four.
- **CCTV, committee, emergency, LOTO, audit and objectives had no cap at all.**

`e2e/capped-reads.spec.js` is what keeps this closed. It runs with
`VITE_TEST_READ_CAP` lowered so the seeded org is already past the ceiling, and
asserts the notice on every screen that totals a capped register — except
portal home, which the owner asked to keep in loading / quiet figures rather
than an incomplete banner. Without it, "the notice exists and is unit tested"
would keep being mistaken for "the page asks for it".

### S-21 · The API server was removed — CLOSED

`server/` was an Express + firebase-admin service intended to take over the
write path. Nothing deployed it and no traffic reached it, but its
`src/authz/policy.js` was a hand-maintained second copy of eight
`firestore.rules` role helpers, annotated with the line ranges it mirrored and
tied to them by nothing. A silent divergence there would have become a hole on
the day the server first served — and the rules could not backstop it, because
the whole point of the service was to bypass them.

Removed rather than maintained: a standing drift risk paid for every month
against a benefit with no date on it. Recoverable from git history at
`b08dc1c` if the migration is revived. Note that `assertSegment` in
`functions/index.js` was the other half of that mirror and is now the only copy.

### S-22 · Root `/sites` was a granted collection nothing used — CLOSED

`isLegacyOrgCollection` in `firestore.rules` listed `sites`, granting read,
create, update and delete on a **top-level** `/sites` collection to any approved
member of any org. The site registry has always lived at
`/organizations/{orgId}/sites`; the only code that ever read the root one was
`src/modules/loto/services/sites.js`, which was imported by nothing.

So this was a whole collection's worth of permission that no code exercised —
the kind nobody can notice is wrong, because nothing fails when it is. Both the
dead file and the grant are gone, and `tests/firestore.rules.test.js` now
asserts the root path is denied for every role, with controls proving the real
org-scoped registry and the remaining LOTO top-level collections still work.

This moved the rules-test count by +7, which is the intended semantic change
`AGENTS.md` asks to be stated rather than assumed.

### S-23 · Colour contrast failed WCAG AA across the design system — CLOSED

Found by the axe pass added in `e2e/accessibility.spec.js`, and by nothing else
— the markup was correct, the colours were not.

`text-ink-400` (494 uses, the app's standard secondary text) measured **2.12:1**
on `clay-bg` against a 4.5:1 requirement; `text-ink-500` (372 uses, every field
label) measured 3.29:1. 43 offending nodes on the portal home alone. The
`ink-400`–`ink-900` ramp was re-spaced — same hue and saturation, lightness
lowered — and `50`–`300` left alone as the surface and border tones they are.

Two derived patterns had the same fault and are now computed rather than
hand-picked, in `src/shared/lib/contrast.js`:

- the soft badge used one colour as both its 10% fill and its text
  (`readableOnTint`), and
- the solid badge wrote white on a mid-tone fill (`solidBackground`).

## Closed

### S-05 · Console-only hardening — CLOSED

Moved to Closed. Recorded here in full because "it is a console toggle" is the
reason this sat open, and the toggles are not visible from the repository —
nothing in a diff will ever tell the next reader whether they were flipped.

Applied: **App Check is enforced** on the public write surfaces, **admin MFA
(TOTP) is enabled**, **application-layer encryption is on**, Firestore backups
are configured (PITR 7d plus a weekly schedule at 30d retention, `PRODUCTION.md`
§3), and the API key referrer restrictions are in place (`PRODUCTION.md` §9,
§9b).

Two things this does NOT close, kept visible on purpose:

- **App Check is the only volume control the anonymous QR surfaces have.**
  Rules cannot count requests. `/reports`, `/observations` and `/defectLocks`
  bound who may write and what they may say, never how often. Turning App Check
  off does not weaken those rules; it removes the only thing standing between a
  photographed QR sticker and unlimited writes on your bill.
- **Console state is not under version control.** There is no test, no CI job
  and no diff that fails if one of these is switched off later. Re-checking them
  belongs in whatever periodic review this project keeps, not in a code review.

### S-01 · Cloud Storage was not tenant-isolated — HIGH

`storage.rules` captured `{orgId}` in the path and checked it against nothing.
Any signed-in user of any tenant could read and delete any other tenant's
uploaded files if they knew the path — incident photos, permit documents, LOTO
procedure photos, training content.

**Fixed** by putting the organization on the ID token. Storage rules cannot
query Firestore, so a claim is the only thing they can learn about a caller;
`syncUserClaims` in `functions/index.js` mirrors `/users/{uid}` onto the token,
and only for an **approved** member — a pending joiner's profile already names
an org, since that is what the waiting room is, so minting a claim from it would
let anyone sign up naming a tenant and read its files at once.

An earlier draft used `firestore.get()`, which needs cross-service rules granted
on the project and costs a document read per file operation. The claim needs
neither and the check is local to the request.

**Two things the emulator caught before this shipped.**

Reading an absent claim as `request.auth.token.orgId` *raises* rather than
returning null. An erroring rule denies, so the outcome was right — but it was
right by accident, and it logged an evaluation error for every signed-in user
who had not been stamped, which during the cutover is all of them.

And the bigger one: **`allow update: if false` does not prevent an overwrite.**
Cloud Storage evaluates an upload onto an existing path as a **create**, so the
update denial never saw it. Both the deployed rules and this register previously
claimed that vector was closed. It was not — any signed-in user of any tenant
could replace another tenant's safety evidence in place, which is worse than
this entry described. Closed by `resource == null` on create, which needed no
claims and shipped ahead of the cutover.

`update` in Storage rules does not mean what it means in Firestore rules, and a
comment asserting a control is not the same as a test exercising one.

**Order mattered.** A token with no `orgId` is denied by every rule in the new
set, so deploying before the claims existed would have locked the organization
out of its own files. Sequence was: deploy functions → run `backfillClaims` →
confirm a real token actually carried the claim → then deploy the rules. The
confirmation step was not ceremony: the backfill reported `0 updated, 2 skipped`,
which is ambiguous between "everyone was already correct" and "nobody
qualified", and only the token settled it.

Verified in `tests/storage.rules.test.js` — 17 cases against the emulator,
minting tokens carrying the same claims `syncUserClaims` stamps.

### S-02 · Manager-only actions were enforced only in React — HIGH

Approving a permit, deciding a defect report, verifying an injury, closing a
finding: each was gated by `can()` in the UI and by nothing else, so the same
write went through unchallenged from the SDK. The value of an approval is that
only the approver could have made it.

**Fixed** by naming only the states that *record a decision* — writing each
module's state machine out in full would be unmaintainable and wrong the first
time someone added a status. `pending`, `draft` and `pending_approval` are
deliberately absent: asking is not deciding, and a member must still be able to
raise a record and submit it. Both directions are gated, because clearing an
approval is as much the approver's act as granting it.

Deliberately **not** decisions: an extinguisher reaching `closed` (refilled —
the ordinary end of the fire workflow), an inspection template going Active, and
a permit's `closedDueToObservation`. Stopping unsafe work is not approving it,
and a rule that sent someone to find a manager before they could stop it would be
a safety defect rather than a control.

The gate lives *inside* the generic collection rule rather than in per-collection
matches, because rules are a permissive union — a narrow match restricts nothing
while the generic one still grants the same write. One conjunct covers every
collection, so adding a module cannot forget it.

Two things fell out of doing it properly. The member branch on `/reports` and
`/observations` create is gone: it was the broader half of a union, and once
approving became a manager's act it would have let any member file a report that
was *already approved* and skip the queue. And `isWriterOf` now covers the QR
mirrors, defect locks, id counters and LOTO collections — each was still a place
an auditor could write.

One boundary that is deliberately **not** role-based: an auditor can still create
a defect lock when they hold a scanned token, because that branch authorises on
proof of physical scan and is open to a stranger with no account at all.
Refusing an auditor something any passer-by can do would be incoherent.

### S-03 · Duplicate reference numbers under concurrency — MEDIUM

`refNo` was issued by a read-then-write, so two reports filed at the same moment
took the same number — and these are the records quoted to a regulator.
**Fixed** with a transaction, following the pattern `reserve.js` already used.

### S-07 · Public QR mirrors could be captured by another tenant — HIGH

`/qr` and `/permitQr` allowed an update if the caller was a member of the org
named in the **post** state, so setting `orgId` to your own org satisfied the
rule regardless of who owned the document.

One signup makes anyone an approved admin of a throwaway org, and a QR token is
not a secret — it is printed on the sticker. Photographing someone else's
extinguisher label was therefore enough to re-point that unit's public page into
your own tenant, where every future defect report scanned from it would land
while the person scanning is told it was submitted and the owner's safety team
hears nothing. The attacker could then rewrite what the next scanner sees, or
delete the mirror so the printed label goes dead.

The permit mirror was worse: the same call lets an expired hot-work permit be
displayed to a fire watcher as approved.

**Fixed** by pinning `orgId` across the write. Costs nothing — every legitimate
writer already owns the mirror it is updating, and a merge write carries the
existing `orgId` into the post state.

**Why the tests missed it:** the existing cross-tenant test only ever sent
payloads that kept `orgId` unchanged, so it exercised the safe branch and never
the capture branch.

### S-08 · LOTO documents could be captured by another tenant — MEDIUM

The same post-state branch on the top-level `procedures` / `locks` /
`technicians` collections, which are tenanted by an `orgId` field rather than by
path. One update captured another org's live isolation procedure. **Fixed** the
same way.

### S-09 · Auditor could write — MEDIUM

`auditor` is documented as read-only across all modules and was read-only only in
React. An auditor is typically an outside party given a login to inspect the
safety record; editing the evidence they are auditing is the one thing the role
exists to prevent. **Fixed** — writes now go through `isWriterOf()`, which
excludes auditors.

### S-10 · A member could widen their own site access — MEDIUM

Self-update pinned `role`, `status` and `orgId`, but not `access` or `siteId`.
Since site-level documents are readable by whoever reaches the site, a member
could grant themselves every restricted document in the org from the browser
console — without touching their role, so nothing looked amiss. **Fixed** by
pinning both fields on the self-update branch. Requesting access still works;
the request is not the grant.

### S-11 · A joiner could choose an elevated role — MEDIUM

Self-registration required only `role != 'admin'`, so a stranger could join as
`manager`. Approval only flips `status` — nothing ever re-asserts the role — so
the admin clicking Approve on a routine-looking join request was granting the
role the joiner had picked. **Fixed** — self-join is `member`, full stop.
Promotion is the admin's to make, afterwards.

### S-12 · Audit log entries could be forged — MEDIUM

`auditLogs` create was unvalidated, so any approved member could write entries
attributing actions to an admin — in the one record that would otherwise show
them doing it. **Fixed** — `actorUid` is pinned to the caller's uid.

### S-13 · Stored XSS via attachment links — HIGH

`AttachmentField.jsx:132` bound a stored attachment URL straight to `href`. Both
the uploaded URL and the hand-typed reference link are attacker-controllable
text, so a colleague could store `javascript:` and wait for the next person to
click. **Fixed** — routed through the existing `safeHref`, which allows only
http(s); a rejected URL degrades to plain text.

### S-14 · Unbounded strings on the anonymous QR surface — LOW

Only `note` was capped; every other free string on the unauthenticated branch was
unlimited, making one scanned token a free megabyte-per-write channel into the
org's approval queue. **Fixed** — all of them capped.

### S-15 · CSV exports were formula-injection vectors — LOW

Exports never neutralised a leading `=`, `+`, `-` or `@`, which Excel,
LibreOffice and Sheets all evaluate as a formula. A trainee's own name typed as
`=WEBSERVICE(...)` runs on the safety manager's machine when they open the
register. **Fixed** — one shared serializer in `src/shared/lib/csv.js` quotes and
de-fangs, with numbers left alone so negatives survive.

### S-16 · CI deployed rules but never indexes — MEDIUM

Every composite index the app relies on existed only because someone had run a
deploy from a laptop; a fresh project would have had none. A missing index is a
hard runtime failure that never shows in the emulator. **Fixed** — indexes ship
with rules, and hosting is now a separate later step so the client cannot go live
ahead of what it depends on.

### S-17 · Site-scoped documents: the rule that looked enforced — HIGH

Documents filed at Site level are readable only by people whose access reaches
that site. The first implementation read the field defensively —
`resource.data.get('visibility', 'all')` — so that documents predating the field
would not break.

That silently disabled the boundary for list queries. `read` covers `get` and
`list`, and for a list Firestore must prove from the rule alone that the query
cannot return a refused document — which it can only do when the condition names
a field **directly**. Written defensively, the single-document `get` was still
refused but an unfiltered **list returned the whole collection, contents and
all**. The same is true of `!('visibility' in resource.data) || …` and of
`keys().hasAny([…])`; all three were checked against the emulator.

Every per-document test passed in all three forms. **Fixed** by reading the field
directly, which costs a mandatory backfill: direct access to a missing field
errors, and an erroring rule denies.

**Rule of thumb this leaves behind:** in any `allow read`, read the queried
document's fields directly. If you find yourself being defensive about a missing
field, you are turning the rule off for lists.

### S-18 · Earlier fixes

`orgIndex` tenant hijack at signup; the defect-lock denial-of-service on the
public QR surface; missing `keys().hasOnly()` on public `/reports` and
`/observations`; `/qr` and `/permitQr` being listable, which made the tokens
enumerable and turned the permit mirrors into a cross-tenant PII dump; and the
first round of URL-scheme validation before binding to `href`/`src`.

### S-19 · A member could take a colleague's sign-in address — HIGH

The self-update on `users` pinned role, status, site, access and department,
but not `email`, which is the sign-in name and where reset links go. Sign-in
and password reset looked the address up with `LIMIT 1` and no order, and
nothing made it unique. So a member could write an admin's address onto their
own profile, and whichever row SQLite returned first owned it:
- when the planted row came first, the admin's correct password failed and
  every attempt counted against the address;
- the attacker signed in under it with their own password, and a reset link
  for it went to the attacker's account;
- an address claimed in advance made `createMember` refuse the real person.
A sole admin had no recovery short of editing the database.

**Fixed** in two places, each enough alone:
- `email` is admin-only (`invariantProblem`, `users_keep_privilege`);
- an address carried by more than one profile signs in to neither and gets no
  reset link (`userByEmail` in `stack/passwords.mjs`). Picking a row is what
  made the copy a takeover; refusing turns it into a visible lockout an admin
  can see and correct. Adding someone still refuses any address already on a
  profile (`emailTaken`).

Tests: `postgres.rls.test.js` "the sign-in address" (a member and a manager
refused, an admin allowed) and `passwords.limits.test.js` "an address on two
profiles" (planted sorted after the real row, so a first-row lookup would
pass).

### S-20 · Two-step login codes could be guessed in bursts — HIGH

The code step counted tries after checking the code: it read the ticket's
try count and the source's failure count, checked the code, then wrote the
counts back. Parallel requests all read zero, so 200 simultaneous wrong codes
on one ticket were all evaluated where five were meant to be. Wrong codes
also never counted against the account, and a right password issued a fresh
ticket, so the count restarted. With the password in hand, the second factor
fell to enough parallel guesses. Turning it off with a code, from a signed-in
session, had no limit at all.

**Fixed** by taking a try before checking, with `bump()`, one atomic statement
that returns the new count (`completeTotpSignIn`, `stack/passwords.mjs`):
- five codes per ticket, then the ticket is burnt;
- `TOTP_FAILURES_PER_ACCOUNT` wrong codes lock the code step for that person
  for 15 minutes; a right password does not clear it, only a right code;
- the per-source limit is taken the same way and given back on success.
Turning it off uses the per-person count; confirming setup allows five codes
per pending secret.

Tests: `passwords.totp.test.js` "guessing codes" (a burst of 200, fresh
tickets from many sources, turning off in parallel, setup), each failing on
the previous code.

### S-21 · Audit entries and names could be forged — MEDIUM

S-12 pinned `actorUid`, but only inside the auditor's insert branch. The
general writer branch admitted every employee first, so for them nothing was
pinned. And for anyone, `at`, `actorName`, `action` and `module` were what the
writer sent: an entry could read "Ada (Administrator) approved a permit",
backdated. Separately, a person could rename themselves, and the name is what
approvals, owner pickers and the Audit Log show.

**Fixed:**
- the actor pin and key-shaped `action` / `module` / `target` are in
  `restrictWrite`, which every insert passes (the permissive-union pattern in
  `AGENTS.md`, again);
- the server stamps `at` and `actorName` from its clock and the writer's
  stored profile on every non-server insert (`serverStampedInsert`, applied
  by the engine before the policy decides);
- `name` joined the admin-only profile fields; an admin renames people from
  Employees → Edit.

Tests: `postgres.rls.test.js` "audit entries say who and when, as the server
knows it".

### S-22 · A work permit's dates and its public QR page could be faked — MEDIUM-HIGH

`permits` and `permitQr` are field collections, because employees carry out
the work, and approving is a manager's decision (`DECISION_STATES`). Only the
approval status fields were guarded, and only on `permits`:
- on an approved permit an employee could set `validTo` years out, and an
  expired permit read as in progress with no extension approved, or rewrite
  its hazards and PPE after the approvers had signed them;
- the public QR record carried its own copies of the approvals, tied to
  nothing: an employee could mark an unapproved permit approved and current
  on the page read at the work location. The same change on the permit itself
  was refused.

**Fixed** in `stack/policy.mjs`:
- after a decision, a non-manager may change only what the app changes on a
  decided permit (closure, extension, an unsafe stop, the derived status, the
  mailed report, the QR token); an approved extension's end date is frozen;
- every write of a permit's QR record must agree with the permit it names,
  for every writer: approvals, dates, extension, unsafe stop, number, site and
  type exactly; each display field either the permit's value or blanked. The
  engine loads the permit (from the stored record when a merge update omits
  `permitId`) and guards it with the rest of the batch.

Tests: `postgres.rls.test.js` "work permits after a decision, and their public
QR record", including the records the app itself writes, built with its own
`mirrorDisplayFields`.

### S-23 · Any path could be laundered into a working download link — MEDIUM

Records are re-signed as they leave the server, so the links the app shows
never expire (`stack/lib/fileLinks.js`). It re-signed every string shaped
like a `/blob` link, whoever had written it and whatever file it named. A
member could type a link naming a medical record's file, or a mailed meeting
report, into any field they may write, read the record back, and receive a
valid download: around `/presign`, which refuses both. It also revived any
expired link, including one the reader had held only while they were allowed.

**Fixed:** a link is re-signed only when
- this server signed it (`signedPath` in `stack/blobSign.mjs`: an expired
  signature, or the older one from before links expired, but a signature);
- and `/presign` would give that file to this reader now (`decidePresign`
  with the reader's live profile: medical files to admins and managers,
  mailed reports to no browser).
Otherwise the stored text goes out unchanged. The app asks `/presign` by path
for anything it shows, under the same rules.

Tests: `worker/fileLinks.handler.test.js` (through the request handler, R2
store) and `src/shared/data/server.test.js` (disk store).

### S-24 · Self-hosted, one stranger could lock everyone out of signing in — HIGH

**Since moot:** self-hosting was removed afterwards; the app runs only on
Cloudflare, where the Worker reads the visitor from `cf-connecting-ip`. The
files named below went with it. Kept as the record of the finding.

The sign-in, reset and two-step limits count per source address, read from
the socket. In the Docker install nobody reaches the app's socket directly:
Caddy or the Cloudflare Tunnel connects to it over the compose network, so
every visitor had the proxy's address. Each "per source" limit was one limit
for the organization: fifty failed sign-ins against made-up addresses, from
one machine, and the admin's correct password answered `throttled`. The
per-address lock, meant to stop a stranger and not the person, could not
tell the two apart. The Cloudflare-hosted Worker was not affected; it reads
`cf-connecting-ip`.

**Fixed** (`stack/clientIp.mjs`):
- compose passes the front door to the app (`FRONT_DOOR`, from
  `COMPOSE_PROFILES`); behind Caddy the visitor is the last
  `X-Forwarded-For` entry (Caddy writes it and does not trust an incoming
  one), behind the tunnel it is `X-OHSMS-Client-Ip`, which the Worker sets
  from `cf-connecting-ip` and strips from what browsers send;
- either header is believed only when the connection comes from a private
  address, the proxy beside the app.

Tests: `stack/clientIp.test.js` (fifty failures from one visitor behind the
proxy, then the admin from another, through a real HTTP server) and
`worker/index.test.js`.

### S-25 · The people directory could be searched by the fields it hides — LOW

`visibleRow` narrows what an employee or a manager is shown of a colleague's
profile: no `mfaEnabled`, `mfaRequired`, `mustChangePassword`, access
request or widget settings (a manager also sees `access`). But a list or a
count could still filter or sort on any field, so `where mfaEnabled ==
false` or `where mustChangePassword == true` answered the question the
narrowing hid: the rows that came back were the colleagues without two-step
login, or still on a temporary password. That is a target list.

**Fixed:** a non-admin's query on `users` may filter and sort only on fields
that caller is shown (`queryProblem` in `stack/policy.mjs`, checked by the
engine's `list` and `count`); anything else is refused. The app filters
people by no field at all, so nothing it does changed.

Tests: `postgres.rls.test.js` "the people directory cannot be searched by
what it hides".

### S-26 · A session could not be ended — MEDIUM

A session token was good for its whole eight hours whatever happened. A
password change, a reset by email, an administrator's password reset, or
turning two-step login on, off or resetting it for a lost phone all left
every token already issued working. A stolen session survived the very steps
someone takes after noticing the theft; only suspending the account ended it.

**Fixed:**
- every profile carries a `sessionEpoch` that only the server writes
  (`invariantProblem`), and every token records the epoch it was issued
  under (`stack/session.mjs`);
- each authenticated request compares the two (`liveSession` in
  `stack/handler.mjs`), and a token from an older epoch is answered 401
  `session-ended`; the app then signs out (`noteSessionEnded`);
- the epoch moves on a password change or reset, on two-step login turned on,
  off or reset, on "Sign out other devices" (Account security) and on an
  admin's "Sign out everywhere" (Employees → Edit). Where the caller's own
  session should continue, the job hands it a fresh token.

The same change made an admin's or an email reset lift the per-source sign-in
lock: both cleared a key with no source in it and left the real lock, so the
person stayed locked out on their own machine.

Tests: `src/shared/data/server.test.js` "ending sessions" (a second session
dies on a password change, other devices, an admin's revoke and reset; no one
can set the epoch back) and `stack/passwords.limits.test.js` "a reset lifts
the lock".

### S-27 · An employee could certify themselves — HIGH

Two registers say who is qualified, and both were open to any employee with
the module:
- **LOTO technicians.** Who is an authorised technician, with a wireman
  licence and its expiry, decides who may be named on an isolation permit
  and hang a personal padlock (`loto/utils/permitModel.js`). Any employee
  with LOTO could add themselves, licence number and expiry made up.
- **Training records.** My Learning lets a person mark a course complete,
  flagged `loggedBy: 'self'`. Nothing held a record to that shape: an
  employee could write a trainer-led record for themselves valid until 2099,
  write one for a colleague, or extend their own record's expiry afterwards.

**Fixed** in `stack/policy.mjs`:
- the technician register is a manager's to change (`restrictWrite`); the
  page is read-only for everyone else, and its import refuses technicians;
- an employee may create a training record only as the self-completion the
  app writes: their own, flagged self, no trainer, dated today (a day either
  side for time zones), with the course's real validity and the expiry it
  gives (`selfTrainingProblem`; the engine loads the course). They may not
  change or remove a record afterwards. Trainer-led records stay a manager's.

Tests: `postgres.rls.test.js` "certifying yourself", including the record
My Learning writes.

---

## Testing

The access rules are tested through the real engine on an in-memory SQLite
(`src/shared/data/adapters/postgres.rls.test.js`), and the server end to end
(`src/shared/data/server.test.js`, `worker/server.test.js`); all run in
`npm test`. Run the suite for the current count: a count in prose goes stale.

Those tests **list as well as get**, and the lesson is worth stating plainly,
because it is why several findings survived a green suite for so long: *an
access test that only sends well-behaved payloads tests the app, not the
rule.* Send the payload an attacker would — the one that claims a role, that
approves its own permit, that asks for the whole collection, that writes a
field the screen never sends.

### S-18 · `xlsx` prototype pollution — CLOSED (residual risk accepted, narrowed)

`xlsx` (SheetJS) carries a prototype-pollution advisory with **no fixed version
on npm**, and it is a *runtime* dependency sitting directly on the untrusted-file
path — the Excel import in Fire (bulk asset upload) and Inspections (question
import).

**Why it is accepted rather than fixed today.** There is nothing to upgrade to:
SheetJS stopped publishing to npm, and the current build is distributed from
their own CDN. Swapping the dependency changes how every import and export in
the product parses files, which is not a change to make in the same commit as a
CI gate.

**What limits it meanwhile.** Both import paths are behind authentication — an
attacker needs an account in the tenant they are attacking. `shared/lib/
workbookGuard` caps file size and row count before parsing, so the classic
resource-exhaustion half is bounded. Prototype pollution remains possible for
someone who already has a login.

**How it is tracked.** `.github/workflows/ci.yml` blocks a merge on **critical**
advisories in the runtime tree, not high, precisely because of this one — a gate
that is red the day it ships teaches everyone to ignore it. The whole tree is
still reported on every run, so it cannot go quiet again.

**To close it:** migrate to the maintained SheetJS build, then raise the CI gate
from `critical` to `high` in the same change. The gate level is the tripwire that
says this is still open.

**Update — closed.** Every import now parses CSV through `shared/lib/parseTable`
(papaparse), so no untrusted file reaches SheetJS. `xlsx` remains a dependency
because the seven EXPORT paths still write real workbooks, and writing from data
we already hold is not a parsing surface — which is the whole of this advisory.

The CI gate was raised from `critical` to **high** at the same time, which was
the tripwire this entry set. It runs `scripts/audit-gate.mjs`: blocks on high and
above, allows a NAMED list, and each entry must state why it is tolerable and
what closes it. Lowering a threshold hides every other advisory at that level;
an allowlist hides exactly one, by name, and reports itself when stale.

**Update — the allowlist entry is gone.** Exports depend on the maintained
SheetJS build (0.20.3, the release that contains the prototype-pollution and
ReDoS fixes). npm does not publish it; the dependency is that build's tarball.
The `xlsx` entry in `scripts/audit-gate.mjs` was removed with it. One test
still calls `XLSX.read` on a workbook that same test just wrote, which is not
an upload. Production reads stay on papaparse.
