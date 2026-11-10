# Enterprise readiness

An honest assessment of what this app would meet, and what it would fail, in a
mid-to-large enterprise procurement or security review. Written against what is
in the repository today, not what is planned.

**Short answer: the access model is ready for a security review, and
two-step login is available; single sign-on, operations evidence and
compliance paperwork are not yet.** The app now runs as one organization per installation on its own
server — on Cloudflare (Workers, D1, R2) or self-hosted — and every read and
write is decided by that server.

**Read this next to `SECURITY.md`, not instead of it.** That file is the
authority on closed findings, and open ones are held privately; this one is
the buyer-facing summary. Where they disagree, `SECURITY.md` is right.

---

## Scorecard

| Area | State | Verdict |
|---|---|---|
| Isolation between organizations | One organization per installation: its own database and files (`AGENTS.md`) | **Ready** |
| Authorization | Admin / Manager / Employee / Auditor; per-employee module permissions; site, region and entity scope; manager-only approvals, verification and deletes; LOTO permit lifecycle — all decided by the server (`stack/policy.mjs`), with hostile-payload tests | **Ready** |
| Authentication | Email and password on the organization's own server; per-source and per-address sign-in limits; temporary passwords must be replaced | **Ready** |
| Two-step login (MFA) | Authenticator-app codes (TOTP), set up by each person on Account security; an admin can require it per person (the server holds the account to its own profile until it is set up) and reset it for a lost phone. Secrets are sealed with `DATA_KEY_MASTER` and never reach `/data`; a code is single-use and a sign-in ticket allows five tries | **Ready** |
| Single sign-on | Not available on the current server | **Not ready** |
| Audit trail | Append-only, actor pinned to the caller; the LOTO activity log likewise | **Ready** |
| Encryption at rest (application layer) | Envelope encryption of personal and health fields (`src/shared/crypto/`), master key held as a server secret; on when the build sets `VITE_ENCRYPTION=on` | **Ready** |
| Files | Expiring download links issued per reader; upload types allow-listed; uploads cannot replace a stored file; medical files to managers only | **Ready** |
| Public QR surfaces | Writes bound to a scanned token, field- and length-limited; mirrors readable by token, never listable | **Ready** |
| Backups / disaster recovery | Cloudflare: D1 point-in-time history (`docs/CLOUDFLARE.md`). Self-hosted: SQLite and files backup (`docs/SELF-HOSTING.md`). No restore drilled on this infrastructure yet | **Partial** |
| Observability | Sentry when a DSN is set; uptime is a GitHub Action against `/health.json`; the deploy checks `/health` (`docs/OBSERVABILITY.md`). No metrics, no on-call rotation | **Partial** |
| Data lifecycle — export | Subject access request, Admin → Maintenance (`docs/DATA-RIGHTS.md` §2) | **Ready** |
| Data lifecycle — erasure & retention | Recycle Bin purge after 30 days. Period table with `NEEDS_LEGAL_SIGN_OFF` (`stack/lib/retentionPolicy.js`); live age-purge of statutory records is off | **Partial** |
| Testing | Unit, access-rule (through the real engine) and server suites in one `npm test`; axe and smoke e2e | **Ready** |
| CI/CD | Lint, audit gate, tests, build on every push; deploy to Cloudflare from `main`; versioned images on `v*` tags (`docs/RELEASES.md`) | **Ready** |
| Secrets handling | Nothing committed; server secrets are Worker secrets or `selfhost/.env` | **Ready** |
| Compliance artifacts | ISO 27001 self-audit written. DPA / subprocessor / pen-test **drafts** in `docs/compliance/` (not signed, not a certification) | **Partial** |

---

## What the move to the organization's own server changed

The app used to run on Firebase, where security rules were the enforcement.
It now runs on its own server, and `stack/policy.mjs` is asked before every
read and write. Protections the Firebase rules carried were re-checked one by
one during the move, and the ones that had not come across were restored and
given tests: manager-only decisions, the LOTO lifecycle and window, the public
mirror field lists, anonymous report bounds, upload types, and the people
directory's field limits. Site scope and per-employee module permissions,
which used to be decided only by the screens, are now the server's.

Firebase is no longer part of the system. The one remaining link is files
attached before the move, which Admin → Maintenance copies off Firebase
Storage (`docs/compliance/SUBPROCESSORS.md`).

---

## The remaining gaps

**Identity.** There is no second factor and no single sign-on on the current
server. Enterprises that require either will ask for it first.

**Retention periods still need a lawyer, not another engineer.** Subject
access works. Erasure is classified but not executed, deliberately. Recycle
Bin purge destroys manager-deleted incidents, illnesses, injuries and
equipment after 30 days. What a privacy review will still ask is **how long a
live statutory record is kept**: that table exists
(`stack/lib/retentionPolicy.js`) with every personal-data row marked
`NEEDS_LEGAL_SIGN_OFF`, and live age-purge is off until those questions are
signed. See `DATA-RIGHTS.md` §3.

**One trap worth naming, if encryption is on.** Every field the
subject-access "mentions" scan would search is a field the crypto policy
seals. A server-side scan for a name therefore reads ciphertext and finds
nothing — and **zero matches is indistinguishable from a person who is
genuinely not mentioned**. `scanFeasibility()` says so out loud; the mentions
half must be done in the browser of somebody entitled to the keys, or
recorded as not performed. `DATA-RIGHTS.md` §2.

**Backups are configured by the platform, and nothing has been restored on
it yet.** A backup nobody has restored is a belief, not a control. The
operator's runbook is where the drill belongs.

**Nothing pages anyone.** Sentry reports errors while the site is up; the
uptime Action emails whoever watches this repository's Actions. Metrics and
an on-call rotation are absent.

**Compliance artifacts are drafts.** `ISO27001-AUDIT.md` is an internal
self-audit. `docs/compliance/` has a DPA stub, a subprocessor list derived
from what the app uses, and a pen-test scope outline — all marked DRAFT /
not legal advice.

**Scalability has a known ceiling.** Collections are read with a cap
(`SECURITY.md` S-04) and aggregation happens in the browser. Fine now; an
organization with tens of thousands of records will find the edge.

---

## What is genuinely strong

- **Access is decided where it cannot be bypassed.** One policy file asked
  before every read and write, with tests that send hostile payloads rather
  than well-behaved ones; the same request from the browser console gets the
  same answer as the button.
- **The audit trail is real.** Append-only, no updates, no deletes, entries
  pinned to the caller.
- **The public QR surfaces are tightly bound.** An anonymous write must
  present a token for the asset it names, so a write is tied to physical
  access to the equipment.
- **Files do not leak through links.** A download link expires within two
  hours and is issued only to someone the server has just let read the record.
- **The seams are real.** Storage and data sit behind adapters with a
  documented contract.
- **The security register is kept honestly.** Closed findings are written up
  with the mechanism, the fix and the test.

---

## Suggested order

1. Single sign-on, if the buyers in view require it
2. Retention periods signed off by someone with legal authority
   (`docs/DATA-RIGHTS.md` §3, `stack/lib/retentionPolicy.js`)
3. A restore drill on the deployed infrastructure, written into the runbook
4. Confirm the uptime Action is watched and that Sentry notifications reach
   someone (`docs/OBSERVABILITY.md`)
5. Counsel-complete the DPA / subprocessor drafts in `docs/compliance/`
6. A penetration test against `docs/compliance/PENTEST-SCOPE.md`

---

## Decisions taken, so they are not re-litigated

Written down because each of these looks like an oversight from the outside, and
each one is a choice.

### Accessibility — WCAG 2.1 AA, enforced two ways

A buyer asking for a VPAT or an accessibility statement can be pointed at
something real rather than an intention:

- **`eslint-plugin-jsx-a11y` at `error`, not `warn`.** Every rule in the
  recommended set, plus `control-has-associated-label`, is enforced and at zero.
  The gate was built as a ratchet — each rule sat at `warn` while its backlog was
  cleared and moved to `error` in the change that cleared it — and the ratchet is
  now fully wound. It cannot regress without failing CI.
- **`@axe-core/playwright` against the rendered DOM** (`e2e/accessibility.spec.js`),
  failing on any serious or critical WCAG 2.1 A/AA violation, over the portal, a
  list page, a form and an open dialog.

Both halves are load-bearing and neither is redundant. The dominant form control
in this app binds its label to its input at runtime, which is invisible to a
static rule and plain to axe; an icon-only button with no name is the reverse.
Static lint for what is statically visible, axe for the rest.

What this found that no review had: the colour palette failed AA at its two
most-used text stops (`SECURITY.md` S-23). The markup was right and the colours
were wrong, which is precisely the class of defect a code review cannot see.

### Offline — the shell only, deliberately

The installed app (PWA) has a service worker that caches the app shell, so a
phone that has opened it once can paint in a dead spot (`docs/MOBILE.md`). It
does not store records, files or server answers: the next person on a shared
phone must not inherit them, and an access change must not hide behind a
cached copy. Capturing or reading records offline is not supported.

If a customer does require offline capture — field inspections in a plant room
with no signal is the plausible case — treat it as a project, not a patch. The
data path is the easy half; the hard half is conflict resolution on a permit or
an isolation procedure that two people edited while apart, and that is a safety
decision before it is a technical one.

### Malware scanning — magic bytes are not a scanner (S-25)

Decision record: `docs/ADR-0001-malware-scanning.md`. Sniff ≠ malware scan;
sealed ciphertext cannot be scanned as plaintext; the two owner choices are
an in-project scanner on unsealed prefixes, or a written exclusion of sealed
medical documents (plus a subprocessor if a vendor is later chosen).

`src/shared/storage/sniffType.js` refuses an executable header and a declared
type the bytes contradict. That is honesty about type, not detection of malice.
A genuine PDF carrying a payload passes, and a test asserts that so the check
cannot be mistaken for more than it is. `docs/SECURITY.md` S-25 is the closed
write-up.

Until an owner chooses one of the two options in the ADR, this stays accepted.
Do not add a pretend scanner in front of ciphertext.
