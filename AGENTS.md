# Working in this repository

Conventions that are load-bearing and not obvious from the file you happen to
open. Most of them exist because breaking them once caused a real defect; where
that is the case, the defect is named so the rule is arguable rather than
arbitrary.

## Where the truth lives

- **`stack/schema.sql` (Postgres row-level security) is the only enforcement
  that cannot be bypassed.** The browser's `/data` calls run as a role with no
  bypass, and the server only sets the session uid. Anything enforced in React
  — `can()`, a hidden button, a disabled field — is a usability feature. The
  same action succeeds from the browser console. If a change makes a
  permission decision, it belongs in the schema (or, for a server job, in the
  job's live-profile check in `stack/`) and needs a test in
  `src/shared/data/adapters/postgres.rls.test.js`.
- **One installation is one organization.** There is no tenant id anywhere:
  collections are top-level (`incidents`, `permits/<id>/events`) and the
  organization is the single document `organization/profile`. Do not
  reintroduce an `orgId` parameter or path segment.
- **`src/shared/modules/registry.js` is the module list.** It drives the
  sidebar, the dashboard grid and route mounting. Do not write the module count
  into a comment; it was wrong for a long time.
- **`docs/SECURITY.md` is the authority on open findings**, and
  `docs/PRODUCTION.md` on operating the deployed system. When another document
  restates either, it drifts. Link instead of copying.

## Three deployable units, two npm packages

`src/` (the app) and `stack/` (the organization's server) each have their own
`package.json` and lockfile; `worker/` is the Cloudflare Worker and has no
dependencies of its own. The root `npm test` covers all three, but needs
`npm ci --prefix stack` first because the server tests import `pg` and SAML.

`stack/lib/` holds rules shared by the server and the app (file deletion,
retention, data keys, subject data). The app imports them by relative path.

## The audit trail

One implementation: `logAudit` in `src/shared/org/orgData.js`. Modules wrap it to
supply their `module` key and a default `target`, and nothing else writes to
`auditLogs`.

This was five copy-pasted copies, and four of them omitted `module`. Admin →
Audit Log renders `MODULE_BY_KEY[l.module]`, so every entry those four wrote
displayed as "Core" and the log could not be filtered back to the module that
produced it. A trail that cannot attribute an action is not a trail.

## Personal data

Two files describe the same personal data for different purposes and live in
different npm packages, so no import can tie them together:

- `src/shared/crypto/policy.js` — which fields get sealed
- `stack/lib/subjectData.js` — where a person's records are, for subject access

A collection added to one and not the other is a silent gap: unsealed personal
data in the first case, a person's records missing from their own legal export in
the second. `EXPECTED_SEALED` in `subjectData.js` is checked by the test suite
for exactly this. Update both.

Before touching subject access, read `docs/DATA-RIGHTS.md` §2 — with encryption
on, a server-side scan for a name reads ciphertext, and **zero matches is
indistinguishable from a person who is genuinely not mentioned**.

## This repository is public — what may and may not be written into it

Everything committed here is world-readable, including git history, and history
is not practically retractable: rewriting it changes every commit SHA and
orphans the `v*` release tags that tie each production deployment to a commit.
So the question is not "should this be removed later" but "may this be written
at all".

**Belongs here.** The code. The security rules — a rule whose strength depends
on nobody reading it is not a rule. Findings that are **closed**, written up in
full with the mechanism, the fix and the test: those are a credential, and the
detail is what makes them one. Design reasoning, rejected alternatives, the
failure that motivated a line.

**Does not belong here.**

- **A finding that is still open**, or accepted with a live residual risk —
  however well written up. The write-up quality is what makes it dangerous: a
  reachability assessment is an argument someone can test. These go in the
  private register; `docs/SECURITY.md` explains the split.
- **Operational description of the live system** — hostnames, tunnel ids,
  Access policies, which settings are on. That stays with the operator.
- **A worked request against production.** A copy-pasteable `curl` at a live
  endpoint is a proof of concept regardless of why it was written.
- **Anything personal.** Real names, real incident narratives, real medical
  detail — in a fixture, a seed script, a test, a screenshot or a comment. Seed
  data is invented. This is the one that gets in by accident.
- **Credentials, obviously**, though nothing here has ever carried one:
  `.gitignore` covers `.env` and `.env.production`, and the full history has
  been searched. Server secrets live in `selfhost/.env`; Worker secrets are
  `wrangler secret put`.

**When unsure, private.** The asymmetry is total: a doc kept private that
needn't have been costs a request to the maintainer; a doc published that
shouldn't have been cannot be taken back.

This is finding H-2 of the 2026-09-09 audit, and it is written here rather than
only in the register because it is a rule about what gets written, and this is
the file that is read before writing.

## Seams

`src/shared/data/` and `src/shared/storage/` are adapter contracts. The header
comment in `src/shared/data/index.js` declares itself to be the specification —
it is, and an adapter that deviates is a bug in the adapter. Module code calls
the Firestore-shaped functions in `src/shared/data/client.js`, which are backed
by the postgres adapter (`postgresClient.js`).

`src/shared/module-kit/service.js` (`createModuleService`) is the CRUD
factory. Prefer it over hand-rolling `collection(db, …)`.

## Testing

- Unit tests run in parallel and are stable there. They were not: the suite
  reported one to four phantom failures under `vitest run`, and the standing
  advice was `--no-file-parallelism`. The cause was `environment: 'jsdom'` set
  globally — 86 of 99 files are pure logic and needed no DOM, and building one
  per file per worker was both the flakiness and 90 seconds of a 160-second run.
  The default is now `node` and the DOM files opt in with a
  `// @vitest-environment jsdom` docblock. **Put that docblock on any new test
  that touches the DOM**; without it the failure is immediate and obvious, which
  is the point.
- RLS tests send hostile payloads, not well-behaved ones. A new policy needs a
  test that tries to defeat it, not one that confirms it works when used
  correctly.
- The RLS and server suites run on embedded PGlite. Set `OHSMS_TEST_PG_URL`
  and `OHSMS_TEST_PG_ADMIN_URL` to run the same assertions on a real Postgres
  with a non-superuser app role (docs/SELF-HOSTING.md, "Testing locally").

## Accessibility is enforced, in two places that do not overlap

`eslint-plugin-jsx-a11y` runs at **`error`** and is at zero. It is not advisory
and it is not a style rule: the sweep that got it to zero found the bulk-upload
drop zones were `<div onClick>` and therefore the only way to import a
spreadsheet was a mouse, and that a fishbone node could be selected, deleted and
gate-flipped from the keyboard but never renamed.

What lint cannot see, `e2e/accessibility.spec.js` does — axe against the rendered
DOM, failing on serious and critical. That division is deliberate:

- **Lint** sees the JSX: an icon-only button with no name, a `<label>` with no
  `htmlFor`, an element that answers a click and nothing else.
- **axe** sees the result: whether the label actually attached, whether the
  contrast is real. `<Field label="Date"><input /></Field>` is the app's dominant
  form control and `Field` binds the two at RUNTIME, which no static rule can
  check. Contrast is the same shape — it found the palette failing AA at its two
  most-used text stops while every line of markup was correct.

Three components take a **required** label and throw in development without one:
`Field`, `IconButton` and `ChartFrame`. That is on purpose. An optional
correctness step spread over hundreds of call sites is one most of them will
skip — which is exactly how ~50 unnamed icon buttons and 174 unattached labels
happened. Do not add a default to make the error go away; give it a name.

For colour, do not hand-pick a shade. `src/shared/lib/contrast.js` computes one:
`readableOnTint` for text on its own tinted chip, `solidBackground` for a fill
that has to carry white text.

## Two failure patterns worth recognising on sight

Both are documented in `docs/SECURITY.md` and both have bitten this codebase
three times each:

1. **The permissive union.** Permissive policies OR together. A narrow policy
   that refuses something is worthless while a broader one grants it; the
   strict case must be `AS RESTRICTIVE`.
2. **The post-state branch.** `WITH CHECK` sees the row *after* the write. A
   policy that authorises against it lets the writer supply the value that
   authorises them; read the actor's profile and `OLD` instead.

## Style

- JavaScript, not TypeScript. No `tsconfig.json` anywhere, and that is
  deliberate — do not introduce one incidentally.
- Prettier: no semicolons, single quotes, width 100. `npm run format`.
- Comments explain *why*, and name the failure that motivated the code. The
  codebase carries no `TODO`, `FIXME`, or `console.log`; keep it that way.
- Line endings are mixed across the repo and `core.autocrlf` is on. Preserve
  whatever a file already uses rather than normalising it in an unrelated diff.
