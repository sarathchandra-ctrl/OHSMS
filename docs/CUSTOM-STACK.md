# Custom stack (path 3)

At **organization registration** the product offers two choices. Auth follows
the choice. The database follows the choice. This document is that product
intent, and the build plan for it. It is not a claim that the second choice
can serve traffic.

1. **Use the WEEHS database.** The organization lives in the shared
   multi-tenant suite: WEEHS Firebase Auth, Cloud Firestore, Firebase
   Storage, Cloud Functions. This is the product as it runs today.
2. **Use your own database.** The organization brings any database it
   chooses, or is provisioned onto one. Postgres is the generic path.
   Supabase is one Postgres flavor, not the only store. Their auth comes
   with that choice — company OIDC, SAML, or Supabase Auth — and is not a
   WEEHS Firebase account with a different label. Supabase Auth does not
   decide the database. Files, row level security, and workers follow the
   same choice.

`docs/PRODUCTION.md` is the pointer to the private runbook for the WEEHS
Firebase deployment. `DEPLOYMENT.md` is that deployment's first-organization
check, post-deploy check, and rollback. This file does not describe standing
up another Firebase project.

**A dedicated own-stack host can serve one company.** `postgres` is a
registered `VITE_DATA_DRIVER`. The browser talks to `VITE_DATA_GATEWAY` (a
URL only) and row level security is the enforcement. `supabase` is still
reserved: selecting it throws `UnimplementedDataDriverError` and does not
open Firestore under that name. A Supabase Postgres uses `postgres`. The
registration screen offers the choice. The shared Firebase build does not
set `VITE_DATA_DRIVER=postgres`.
`src/pages/auth/RegisterOrg.jsx` still creates a WEEHS Auth user and a shared
Firestore organization when the founder chooses the WEEHS database
(`registerOrganization` in `src/shared/auth/AuthContext.jsx`). The other
choice files a non-secret provisioning request
(`src/shared/org/provisioningRequest.js`) and does not call
`registerOrganization`. A filed request has status `requested`. It is not a
live stack, it has no dedicated URL yet, and it does not open a session.
Adapters, row level security, the auth replacement, workers, and the
dedicated environment are still the gap list below. Two buttons that both
called `registerOrganization` would put the company on the WEEHS database
while the label said otherwise. That is not what this screen does.

The default build is unchanged: `VITE_DATA_DRIVER` unset or `firestore`,
`VITE_STORAGE_DRIVER` unset or `firebase`.

## The choice

|                    | Use the WEEHS database                                                          | Use your own database (path 3)                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chosen at          | Organization registration                                                       | The same step, the other branch                                                                                                                                    |
| What happens today | `RegisterOrg.jsx` creates a WEEHS Auth user and a shared Firestore organization | The wizard files a non-secret request. The control plane emails a one-time handoff link; submitting it fulfills the request and serves that company on its own URL |
| Database           | Shared Cloud Firestore, org under `organizations/{orgId}`                       | Any database the company chooses. `postgres` is the generic driver                                                                                                 |
| Files              | Firebase Storage                                                                | S3-compatible (`s3` driver exists; see the file section)                                                                                                           |
| Auth               | WEEHS Firebase Auth, including its SAML/OIDC and TOTP                           | That company's IdP. Not a WEEHS Firebase user                                                                                                                      |
| Enforcement        | `firestore.rules`, `storage.rules`                                              | RLS, bucket policy, presign checks                                                                                                                                 |
| Background work    | `functions/` on the shared project                                              | Workers for that company's stack                                                                                                                                   |
| Secrets            | WEEHS deploy config                                                             | That stack's deploy config, via a secure channel. Never a database password in the SPA                                                                             |
| Serves traffic     | Yes, on the shared suite                                                        | On that company's dedicated URL, after fulfillment, for `postgres` plus OIDC, SAML, or Supabase Auth                                                               |

## Registration

The choice is the first step of organization registration, before any account
is created. It is a product decision recorded as non-secret intent. It is not
a driver flag the browser flips, and it is not a connection string.

### Use the WEEHS database

The branch that exists today:

1. The form in `RegisterOrg.jsx` collects organization name, address, the
   founder's name, work email, and a WEEHS password.
2. `registerOrganization` creates the Firebase Auth user first. Org-name
   lookup is allowed only to a signed-in caller, which is why the account
   exists before the organization does.
3. `createOrganization` in `src/shared/org/orgData.js` writes the organization,
   the approved admin profile, and the public `orgIndex` entry in one batch.
4. The founder lands in the portal. Teammates join from `Signup.jsx` by typing
   the organization name. They get a WEEHS password account, status `pending`,
   and an admin approves them.

That sequence stays the WEEHS branch. Do not insert a stack label into it
and keep calling the same functions.

### Use your own database

This branch files a provisioning request. It does not serve traffic.

The screen is a wizard (`src/pages/auth/OwnStackRequest.jsx`). It collects
**non-secret** configuration and hands a provisioning request to the WEEHS
control plane (the platform operator side, not a tenant admin writing their
own database). The write is `fileProvisioningRequest`. It does not call
`createUserWithEmailAndPassword`, `registerOrganization`, or
`createOrganization`. Secrets travel on a channel that does not put them in
the SPA and does not write them to a client-readable document. That channel
is `POST /intake` on the control-plane host (`stack/server.mjs`). The wizard
still has no field for them.

The wizard may ask:

- Organization name, address, and the founder's name and work email, as
  contact details. Not a WEEHS password, and not a call to
  `createUserWithEmailAndPassword`.
- Which of the three hosting modes they want, and which database engine.
  All three modes are offered. The company may bring any database. WEEHS
  provisions Postgres, the generic path, either in the company's cloud
  account or in a dedicated project WEEHS operates for that company alone.
  Supabase is one flavor of Postgres they may bring, not a required engine.
  The request records the mode and the engine name. It does not collect
  the credentials.
- Auth method. The first wizard offers company OIDC, company SAML, and
  Supabase Auth. The issuer URL and client id are public. The client secret
  is not a field on this form. In-app TOTP on this branch is optional and
  off unless the company turns it on. WEEHS's own TOTP requirement is
  unchanged and does not apply here. When the company's IdP already
  performs MFA, a second TOTP inside the product stays off.
- File store: a bucket WEEHS provisions, or theirs. The bucket name, region,
  and presign endpoint URL are configuration. The access key is not.
- A contact for the secret handoff.

Then it stops. The confirmation shows the request id and status `requested`,
and says the dedicated URL does not exist yet. The founder does not enter
`/portal`, and no `organizations/{orgId}` tenant is created by
`createOrganization`. The control plane holds the request with status
`requested`. When mail is configured, filing that request on the control
plane (`POST /requests`) or starting intake for one that is already
`requested` (`POST /intake/start`) emails `handoffContact` — or
`contactEmail`, when no handoff contact was given — a one-time HTTPS link.
The token is in that link and nowhere else: only its hash is stored. The
confirmation says the contact is emailed when mail is configured. The shared
wizard does not send the link and does not see the token. A platform
operator can read the request at `/platform/provisioning`. That page lists
the non-secret fields and cannot mark the request provisioned —
`firestore.rules` refuses the update to every client, operator included.
There is no sign-in until that company's IdP is live: no temporary WEEHS
account, and no session on a URL that does not exist yet. Module data does
not exist for that company until the stack is actually provisioned.

On the shared suite, filing also mails the founder an acknowledgement (what
was recorded, what happens next, and "ignore this if it was not you") and
alerts each platform operator (`notifyProvisioningRequested`,
`stack/lib/registrationMail.js`). That mail carries no link and no
secret, and it is not the handoff. The filing is anonymous and the address
is whatever was typed, so the acknowledgement is throttled per address and
per hour. A WEEHS-database registration gets a welcome mail instead
(`notifyOrganizationCreated`), sent to the founder's Firebase Auth address.

Filing the request reserves the name. The same batch writes `orgIndex/{key}`
with `stack: 'own'` and the request id, and nothing else — no contact email
on the public row. `findOrgByName` returns that door, and `Signup.jsx` will
not create a WEEHS password account for the name. A second own-stack request
under the same name is refused, and so is `registerOrganization`.

Secrets, after the request exists:

- The handoff contact opens the one-time link. The page is `GET /handoff` on
  the control-plane host (`stack/server.mjs`), not a route in the shared SPA.
  It posts only the allowlisted fields from `stack/intake.mjs` (`databaseUrl`,
  `sessionSecret`, `oidcClientSecret`, `samlIdpCert`, `samlEntryPoint`,
  `supabaseAnonKey`, `supabaseServiceRole`, `dataKeyMaster`, `s3AccessKeyId`,
  `s3SecretAccessKey`, `smtpPass`). The response does not echo them, and they
  are not copied onto the provisioning request.
- The token is one-time. The wrong email is refused, and so is a reused
  token. A public `http` origin is refused as well; loopback is the local
  demo exception. When mail was not sent, the start response is the one
  place the token is shown, and only to the operator.
- A successful `POST /intake` stores those secrets and runs the same
  fulfillment as `POST /fulfill`. Status becomes `live`, the dedicated URL
  is assigned, and the founder is mailed that the organization is ready.
  The handoff page shows that URL and no secrets. Fulfillment still refuses
  when the secrets are missing for the chosen mode and engine, and it does
  not mark the request live in that case.
- `POST /fulfill` stays for an operator retry when the secrets are already
  stored and the request is not live. It still requires the control token.
  The happy path does not wait for that call. The wizard still does not
  grow a password field.

What the request record may contain: the choice (`weehs` is not this
branch), contact, auth method, issuer URL, client id, which of the three
hosting modes, the engine name (`postgres`, `supabase`, or a name this
document has reserved for a later adapter), bucket name, presign URL,
status. What it must not contain: database URL, database password,
service-role key, S3 secret, IdP client secret, `DATA_KEY_MASTER`.

When the control plane finishes, that company's users sign in with **that
company's auth** against **that company's database**. Joining is not
`signUpMember` on the shared Firebase project. A person who types that
organization's name into the WEEHS signup form must not receive a WEEHS
password account inside it. Anyone may file that request. Filing it reserves
the name, and `findOrgByName` says the organization uses its own sign-in,
instead of "no such organization" — which is how a duplicate WEEHS tenant
gets created when the name is not reserved.

Fulfillment is a **dedicated environment and a dedicated URL** for that
company. The control plane sets that environment's deploy config
(`VITE_DATA_DRIVER`, `VITE_STORAGE_DRIVER`, the presign URL, the auth
issuer). Those flags stay fail-closed until an adapter for that engine
is registered. `postgres` and `supabase` still throw, and so does any
later name added to `RESERVED_DATA_DRIVERS`. One environment is one build with
one driver, which is what `src/shared/data/index.js` can express. The
shared suite does not route that company to another database after login.
Their users use their URL.

Auth is per choice for the life of the organization:

- WEEHS database → WEEHS Firebase Auth. SSO providers in
  `VITE_SSO_PROVIDERS` are Firebase Identity Platform ids (`saml.` /
  `oidc.`). They are not the company's own-stack IdP.
- Own database → the IdP named in the wizard (OIDC, SAML, or Supabase Auth).
  Users of that organization are not also WEEHS Firebase users.
  `registerOrganization`'s "create the auth user first" order is the WEEHS
  branch only. While the request is `requested`, there is no sign-in. Status
  to the contact is the handoff mail and, after fulfillment, the ready mail,
  both sent by the control plane when mail is configured. The confirmation
  screen and `/platform/provisioning` are the record on the shared suite.

Which modules an own-stack company may use is that company's decision, made
by its admins and enforced in its database. `/platform` does not decide it.
On the WEEHS database, `/platform` still does (`docs/PLATFORM-CONSOLE.md`).
A module flag that only hides a tile is not the control, on either stack.

The choice can be changed later, in either direction, only by the planned
migration below. It is not a toggle, and it is not a second live stack the
SPA picks between.

## Non-goals

- **No database password in the SPA.** The wizard is allowed. A connection
  string, an S3 secret, a service-role key, or a database password is not a
  field on it. The browser cannot be given a credential that bypasses RLS.
- **No half-built registration branch.** The two choices are on
  `RegisterOrg.jsx`. The own-stack path does not call `registerOrganization`.
  A label on a WEEHS org is not a custom stack. Do not point the own-stack
  submit handler at the WEEHS one.
- **No runtime switch that reads a secret.** The SPA does not read a driver
  name or a connection string out of `organizations/{orgId}` and talk to a
  different database. The organization's stack is fixed when the control
  plane provisions it.
- **No privileged database URL in a `VITE_` variable.** Vite inlines every
  `VITE_` value into the client bundle. That bundle is public to anyone who
  can load the app.
- **No new Express policy service.** `server/` was removed because a second
  hand-maintained copy of the role helpers drifted from `firestore.rules`.
  Path 3 does not revive that. RLS is the enforcement, the way the rules
  file is the enforcement on Firebase.
- **`memory` is not path 3.** `VITE_DATA_DRIVER=memory` is an in-process
  driver for tests and demos. It has no tenancy enforcement. Do not deploy
  it.
- **No half-registered adapter.** `postgres` implements the whole contract
  in `src/shared/data/index.js`, with schema and RLS in `stack/`. The next
  engine stays reserved until its adapter does the same. A file that
  implements the reads and not `createExclusive` would make the name
  resolve and then fail on the first exclusive create.
- **`firestore.rules`, `storage.rules`, and the CI gates stay as they are.**
  Path 3 does not weaken them so a future adapter can write.

## Where secrets live

Record the choice in the deploy config for that environment: CI variables
for the public flags, and a secret manager or a gitignored env file for
credentials. `.gitignore` already covers `.env`, `.env.production`, and
`.firebaserc`. `functions/.env` and `functions/.secret.local` are the
existing server-side slots on the Firebase path; a path 3 host uses its own
secret store with the same split.

Public by construction (they end up in the bundle):

- `VITE_DATA_DRIVER` — `firestore` (default), `memory` (not a production
  store), `postgres`. `supabase` still throws until that flavor's adapter
  is registered.
- `VITE_DATA_GATEWAY`, `VITE_AUTH_ISSUER`, `VITE_AUTH_CLIENT_ID`,
  `VITE_AUTH_METHOD` — public own-stack config. No client secret, database
  URL, or password.
- `VITE_STORAGE_DRIVER` — `firebase` (default) or `s3`. `s3` is implemented.
  It is a file-store swap, not a whole custom stack.
- `VITE_S3_PRESIGN_ENDPOINT` — a URL only. No access key in the URL, the
  query, or the path.

A Supabase **anon** key may be baked into the client, and only because RLS
is what makes that safe. The **service-role** key bypasses RLS. It stays on
the workers. It is never a `VITE_` variable and never a field in a document
the client can read.

Server-only. Names already used on the Firebase path, so a rehost keeps the
same split rather than inventing client copies:

- **Database URL for the bypass role, or the Supabase service-role key.**
  Held by migrations, key release, and retention. It is the credential
  that does not consult RLS.
- **S3 access key and secret.** The presign host only.
  `src/shared/storage/adapters/s3.js` does not hold them.
- **Session signing secret** for the auth replacement. The auth service
  holds it. A forged session is a forged org.
- **`DATA_KEY_MASTER`.** The key-release worker for that environment.
  On the shared suite this is WEEHS's master. On an own-stack organization
  it is that company's master and only theirs: not the shared secret, and
  not a copy kept in the shared suite's secret store. Losing it destroys
  the sealed records wrapped under it. The comment on `VITE_ENCRYPTION` in
  `.env.example` is the constraint. Do not keep a second copy of the
  encryption procedure.
- **`SMTP_PASS`.** The mail worker. `DEPLOYMENT.md` §6 and
  `functions/.env.example`.
- **`WA_APP_SECRET`, `WA_ACCESS_TOKEN`, `WA_VERIFY_TOKEN`.** The WhatsApp
  worker. `functions/.env.example`.

`AUTH_WEB_API_KEY` is the Firebase password-completion key used by Cloud
Functions. A path 3 auth provider updates the password on its own server.
That key is not reused, and it is not copied into the client.

## Adapter map

The contract for the database seam is the header of
`src/shared/data/index.js`. It is the specification. `adapters/memory.js` is
the second implementation and the one to read before writing a third.
`src/shared/data/README.md` is the short version that sits next to the code.
This file does not restate the contract. It says what path 3 has to attach
to it.

### Database — any engine, one driver per adapter

The company chooses the database. Supabase is not the data store. Auth and
the database are separate: Supabase Auth is one IdP beside OIDC and SAML,
and it does not require the `supabase` data driver.

Registered today: `firestore`, `memory`, `postgres`.

Reserved, not registered: `supabase`.
`src/shared/data/resolveDriver.js` throws
`UnimplementedDataDriverError` when the build selects a reserved name and no
adapter is in the `DRIVERS` map. `postgres` is registered, so a dedicated
build may set it. `supabase` is still reserved. An unknown string still
falls back to `firestore`, so a typo cannot take down the Firebase
deployment. A name this repository has published is not treated as a typo.
Publish a new engine by reserving its name in the same change, or a build
that sets it will quietly use Firestore.

`postgres` is the generic path. One adapter covers Postgres-protocol
servers — a database the company runs, or one a host runs for them,
including Supabase's Postgres. The host is deploy config. The driver name
does not change because the host changed. Neither a database URL nor a
password is a `VITE_` value. The browser role is one RLS constrains. The
bypass role stays on the workers.

`supabase` is one flavor of that path, not a second product. Use it when
the environment talks to Supabase through Supabase's client and Realtime.
A company on Supabase's Postgres that does not need those libraries uses
`postgres`. A company that uses Supabase Auth and some other database uses
their IdP with that database's driver, not `supabase`.

Any other engine is its own adapter. It is not an alias of `postgres`.
MySQL is not Postgres. Naming it on a request does not make `postgres`
speak it.

The mapping below is the `postgres` adapter's. Another engine writes its
own notes. The guarantees in that list do not change with the engine.

#### Registering another engine

Do this only when the adapter implements the whole contract. A file that
implements the reads and not `createExclusive` would make the name resolve
and then fail on the first exclusive create.

1. Add the name to `RESERVED_DATA_DRIVERS` in
   `src/shared/data/resolveDriver.js` and to the reserved list in this
   document, in the same change, before anyone sets `VITE_DATA_DRIVER` to
   it. The test in `resolveDriver.test.js` pins the reserved list. Update
   that test in the same change. Until the adapter exists, selecting the
   name throws.
2. Write `src/shared/data/adapters/<name>.js` implementing every guarantee
   in the header of `src/shared/data/index.js`. Read `adapters/memory.js`
   first. It is the smallest honest version, and it is not a production
   store.
3. Import that file in `src/shared/data/index.js` and add it to `DRIVERS`.
   The import is static. `subscribe` must return its unsubscribe
   synchronously, so the SDK cannot be loaded with a dynamic `import()`.
   The day the adapter is registered, its SDK is in the main bundle.
4. Remove the name from `RESERVED_DATA_DRIVERS` in that same change.
   Registration wins if the removal is forgotten; delete it anyway so the
   name stops meaning "unimplemented".
5. Run the contract assertions in `adapters/memory.test.js` against the
   new adapter. That file says they should hold for any other driver.
6. Set `VITE_DATA_DRIVER` to that name only in the company's dedicated
   environment, and only after step 4. A reserved name with no adapter
   throws at startup. An unreserved unknown name selects Firestore.

WEEHS-provisioned databases — in the company's cloud account, or in a
project WEEHS operates for that company — are Postgres, driver `postgres`.
A company that brings another engine names it on the request. That
environment does not set `VITE_DATA_DRIVER` to the new name until step 6.
Supabase's Postgres is `postgres` unless the flavor in the paragraph above
applies, in which case the driver is `supabase`.

The `postgres` mapping, when that adapter is written:

- One table per collection path, or one documents table keyed by the full
  path. The seam addresses `(path, id)` and is deliberately not org-scoped
  by construction: public QR mirrors, `users`, `orgIndex`, and LOTO's
  top-level collections are written in the same batch as an org document.
- `org_id` plus `jsonb` is the natural row. Tenancy is RLS, not the path
  helper.
- `subscribe` / `subscribeDoc` return their unsubscribe function
  **synchronously** and deliver the first emission asynchronously. The
  registry is a static import for that reason. A dynamic `import()` of the
  Postgres SDK cannot meet the contract without changing every caller. The
  day the adapter is registered, its SDK is in the main bundle. That cost
  is accepted.
- `createExclusive` is `INSERT … ON CONFLICT DO NOTHING` with a rowcount
  check, or a primary-key violation. It is never `SELECT` then `INSERT`.
- `update` rejects when the row is absent. An upsert rewinds the incident
  reference-number counter. The contract header says how.
- `count` is a real aggregate, or it returns `null`. A count that reads the
  rows is not an implementation of it.
- A batch is one transaction across arbitrary collections.
- Stored values pass through unchanged. Do not normalise Firestore
  `Timestamp` values to ISO strings on read. Call sites read `.seconds` and
  `.toDate()`. An all-zero comparator leaves the original order, so the
  list looks fine and is wrong. `src/shared/data/README.md` has the detail.
- Say so in the adapter's notes, rather than emulating them: a Firestore
  `where('x','==',null)` does not match a missing field, and `orderBy`
  drops documents that lack the ordered field. SQL returns those rows.
- `serverTimestamp`, `increment`, and `arrayUnion` resolve on the server,
  `increment` without a read.

### Files — `VITE_STORAGE_DRIVER`

`s3` is the path 3 file driver. It is registered
(`src/shared/storage/adapters/s3.js`). The browser never holds the bucket
credential. It `POST`s to `VITE_S3_PRESIGN_ENDPOINT`:

- `{ op: 'put', path, contentType }` → `{ uploadUrl, publicUrl }`
- `{ op: 'delete', path }` → `{ deleteUrl }`

The endpoint checks the caller's session and that `path` starts with
`orgs/<orgId>/`, which is what `storage.rules` checks on Firebase. The path
layout comes from `storagePath()` and is backend-neutral on purpose.

What `s3` does not do:

- It still sends `Authorization: Bearer <Firebase ID token>`. Until Auth is
  replaced, an S3 bucket in front of a Firebase session is a file-store
  swap. Say that to the organization. Do not describe it as path 3.
- `removeFile` on the Firebase driver goes through the `deleteOrgFile`
  callable, because a Storage rule can only see the ID token and a token
  stays valid for up to an hour after the person is suspended, demoted, or
  moved (`storage/index.js`, the S-19 note). The S3 driver deletes through
  the presign endpoint. That endpoint has to re-read the live profile. A
  bucket policy that trusts the bearer token alone reopens the same hole.
- `putFile` returns null when the bucket is unreachable, and callers then
  write the bytes inline into the database document (under
  `MAX_INLINE_BYTES`). On a mixed deploy those bytes still land in
  Firestore. The magic-byte check and the sealing step run before the
  adapter and stay in `src/shared/storage/`.

`firebase/storage` is imported only by
`src/shared/storage/adapters/firebase.js`. Call sites already go through
`putFile` / `removeFile` / `fileUrl`. The file seam is the one that is
actually in use.

Setting `VITE_STORAGE_DRIVER=s3` while the database is still Firestore is
allowed. It is not a custom-stack cutover.

### Auth — follows the registration choice

There is no `VITE_AUTH_DRIVER`, and this change does not add one. A facade
that still calls Firebase would claim a seam the call sites do not go
through, and a flag on the shared build would force every organization
through one IdP. The registration choice is what selects the IdP: WEEHS
Firebase Auth, or the company's OIDC, SAML, or Supabase Auth. The company's
IdP is wired to that company's stack, not bolted onto a WEEHS Firebase user.

Identity for the WEEHS branch is created in
`src/shared/firebase.js` and consumed by:

- `src/shared/auth/AuthContext.jsx` — session, sign-up, sign-in, SSO
  popup/redirect
- `src/shared/auth/mfa.js` — TOTP
- `src/shared/auth/sso.js` — `VITE_SSO_PROVIDERS`
- `src/shared/auth/provisioning.js` — a secondary app, so creating a user
  does not replace the admin's session
- `src/pages/auth/ForcePasswordChange.jsx`
- `src/shared/auth/platformAdmin.js` — the operator grant, read from
  Firestore
- the S3 presign header
- every Cloud Function that reads `request.auth`

The session a replacement issues has to be able to prove the same facts the
rules use: `uid`, `orgId`, `role`, `status == approved`, and
`mustChangePassword`. Custom claims exist on Firebase because Storage rules
cannot query Firestore (`syncUserClaims`). RLS can query the profile table.
Use that live read for deletes and for presign. A claim mirror that is
trusted on its own for an irreversible delete is the S-19 failure again.

SAML/OIDC and TOTP are part of the WEEHS product
(`docs/ENTERPRISE-READINESS.md`). The own-stack branch uses the company's
IdP. In-app TOTP there is optional and off unless that company turns it on.
WEEHS admins are unchanged.

Anonymous routes (`/qr/:token`, `/permit/:token`, `/p/:id`, `/t/:id/:point`)
have no session. Their write is bound to a token that resolves to one org
and one asset. The replacement has to keep that binding in the database
policy, not in React.

App Check is what stops those public writes being scripted on Firebase
(`docs/ENTERPRISE-READINESS.md`). A path 3 host picks a replacement for that
control before those routes are exposed on the new stack. This document
does not specify the vendor.

### Security — RLS and bucket policy

`firestore.rules` and `storage.rules` stay the enforcement for the Firebase
deployment. Path 3 translates them. It does not edit them to be weaker.

`can()` in `src/shared/auth/permissions.js` is a usability feature. The same
write succeeds from the browser console unless the database refuses it.
That sentence is the whole security model (`docs/SECURITY.md`, `AGENTS.md`).

A single `org_id = auth.uid()` policy is not a translation. The rules file
is large because the exceptions are the product. Top-level paths a policy
set has to cover, not only `organizations/{orgId}`:

- `users/{uid}` — profile, role, approval, the password-change gate
- `organizations/{orgId}` and everything under it, including append-only
  `auditLogs` and the manager-only medical collections
- `orgIndex/{key}`
- `qr/{token}`, `procedureQr/{procedureId}`, `permitQr/{token}` — anonymous,
  token-bound
- `lockClaims/{claimId}`, `lotoEvents/{eventId}`
- `platformAdmins/{uid}`, `moduleEntitlements/{orgId}`
- the legacy collection wildcard in `firestore.rules`

`storage.rules` matches `orgs/{orgId}/…` and a stricter match for
`medical-records`. The presign endpoint and the bucket policy are the
replacement. Medical objects are not a second public prefix.

Two bugs have each shipped three times on Firestore, and both exist in SQL.
`docs/SECURITY.md` and `AGENTS.md` name them. Write the policies so they
cannot come back:

1. **Permissive union.** Postgres ORs permissive policies for the same
   command. A narrow policy does not take away what a broad one grants.
   The strict case is a restrictive policy. Add a test where both match
   and the narrow one wins.
2. **Post-state check.** `WITH CHECK` sees the row after the write. `USING`
   sees the row before it. Authorise the writer from the existing row. A
   policy that reads the new `role` to decide whether this writer may set
   `role` is the bug.

The rules suite sends hostile payloads. A path 3 suite has to do the same:
org A cannot read org B, a member cannot perform a manager action, an
anonymous write without the token is refused, an auditor cannot delete a
file. A test that confirms the happy path is not that suite. After any
future edit to `firestore.rules`, the rules-test count must stay the same
unless the semantic change is intentional (`AGENTS.md`). Path 3 does not
touch that count.

Enable RLS on every table the browser role can see, including the tables
that are not org-scoped. A table with RLS off is world-readable to the
anon key.

### Cloud Functions equivalents

`functions/index.js` is the inventory. `src/shared/functions.js` is the
client that calls it, and it imports `firebase/functions`. Path 3 replaces
that client with whatever RPC the new host exposes. Do not point the
existing callable client at a non-Firebase URL and hope.

Triggers today are Firestore `onWrite`. On Postgres they are triggers or a
transactional outbox written in the same transaction as the row. A poller
that can miss a write will miss an assignment. The pure planning functions
under `stack/lib/` are what can move. The `onCall` wrappers are the
Firebase binding.

Before any tenant is served from path 3:

- **Stamp identity from the live profile** — `syncUserClaims`,
  `backfillClaims`. A pending member must not receive a tenant.
- **Password change** — `completePasswordChange`. Member checks fail while
  `mustChangePassword` is set (`passwordIsOwn` in `firestore.rules`). Only
  this path may clear it, and only after the password itself is replaced.
- **Release data keys** — `getDataKeys`. The master stays server-side. The
  caller receives only the classes their role allows. Read
  `docs/DATA-RIGHTS.md` §2 before porting any search for a person: with
  encryption on, that search reads ciphertext, and zero matches is
  indistinguishable from a person who is not mentioned.
- **Seal stored objects** — `sealStoredObjects`. Same master key.
- **Delete a file** — `deleteOrgFile`. The check reads the live profile.
- **Subject-access export** — `exportSubjectData`. Read
  `docs/DATA-RIGHTS.md` before porting the scan.
- **Retention purge** — `purgeSoftDeleted`. It destroys records.
  `stack/lib/retentionPolicy.js` marks personal-data rows
  `NEEDS_LEGAL_SIGN_OFF`. Do not start a new scheduler that deletes
  statutory records.
- **Stale permit mirrors** — `withdrawStalePermitMirrors`. A stale mirror
  is a safety lie.
- **LOTO permit sweep and purge** — `sweepLotoPermits`,
  `purgeClosedLotoPermits`.
- **Mail the product already sends**, if that deployment sends mail. The
  secret stays `SMTP_PASS`. The exports are `notifyIncidentAssignment`,
  `notifyIllnessAssignment`, `notifyDrillAssignment`,
  `notifyTrainingAssignment`, `notifyIncidentReported`,
  `notifyPermitLifecycle`, `notifyLotoPermitLifecycle`,
  `notifyDefectReported`, `notifyExtinguisherDefect`, `notifyAedDefect`,
  `notifyFasDefect`, `notifyDrillReport`, `notifyCommitteeMeeting`.

Can follow the cutover. They are maintenance, analytics, or a channel:

- One-time backfills: `backfillDocumentVisibility`, `backfillQrMirrors`,
  `linkEquipmentSites`, `seedInjuryRecords`, `stripIncidentMedicalDetail`,
  `confineMedicalRecords`, `clearOrphanedDefectLocks`
- Metabase: `metabaseConfig`, `metabaseTest`, `metabaseQuery`. The URL
  check in `stack/lib/metabase.js` exists so an admin setting cannot
  become a request to a private network. A rehost keeps that check.
- Weather: `fetchSiteWeather`, `sendWeatherRiskDigest`,
  `retryWeatherRiskDigest`
- WhatsApp: `waWebhook`, the link and org callables, `notifyWhatsAppLinked`,
  `buildWhatsAppSnapshots`, `purgeWhatsAppLedgers`
- `refreshSiteAuditCache`, `listPlatformOrganizations`

`scripts/_firebase.mjs` and the scripts that import Firebase
(`seed*.mjs`, `seed-erp-baseline.mjs`, `seed-baseline.mjs`,
`seed-illness.mjs`, `seed-injury.mjs`, `seed-load.mjs`,
`seed-orgsettings.mjs`, `seed-sites.mjs`, `add-illness-action.mjs`,
`backfill-document-visibility.mjs`, `dedupe-cctv-merakis.mjs`,
`inventory-download-tokens.mjs`) are tools for the Firebase path. Setting
`VITE_DATA_DRIVER` does not retarget them. Demo seeds stay off a real
project; `DEPLOYMENT.md` already says so.

## What already goes through a seam

Data, three call sites:

- `src/shared/module-kit/service.js` — generic org-scoped CRUD
- `src/modules/documents/lib/folderService.js`
- `src/pages/Dashboard.jsx` — streams `incidents` and `assessments` through
  `createModuleService`, and counts live permits and expiring training
  records through `dataProvider.count`. The audit-log strip still comes
  from `subscribeAuditLogs` in `orgData.js`, which is Firestore.

`src/modules/documents/lib/service.js` writes through `createModuleService`
and **subscribes with `firebase/firestore` directly**, because a
site-scoped library cannot read the whole collection. Moving documents
means moving that subscribe in the same change as the writes.

Files: every upload goes through `putFile`. See the file section above.

That is not most of the app. `createModuleService` also calls
`reserveDocId` (`src/shared/docId/reserve.js`) on every create, and that
reservation is a Firestore transaction. A seam-backed create still takes
its reference number from Firestore until `docId/` moves. Splitting those
two is how two incidents receive the same printed number.

`module-kit`'s `subscribe` passes an error callback that renders an empty
list. The contract says a refused read must not look like "there is nothing
here". On path 3 an RLS denial, or an `orderBy` the new store rejects,
would show an empty module. Fix that callback when the first real module
moves, not by teaching the adapter to swallow errors.

## Gap list

Regenerate with:

```bash
grep -rl "firebase/firestore\|firebase/storage" src --include="*.js*" | grep -v shared/data/adapters | grep -v shared/storage/adapters
```

That command does not see `firebase/auth` or `firebase/functions`.
When the list and the tree disagree, re-run the grep and fix this file.
Do not keep a second inventory in `src/shared/data/README.md`.

Module libraries no longer import `firebase/firestore`. They import
`src/shared/data/client.js`, which calls the Firebase SDK on the WEEHS build
and the postgres adapter when `VITE_DATA_DRIVER=postgres`. The product files
the grep still finds are `src/shared/firebase.js` (WEEHS bootstrap) and
`src/shared/data/client.js` (the forwarder). The Firestore and Storage
adapters are excluded by the grep on purpose.

What is still open, and is why a dedicated host is not a claim that every
Firestore rule has a line-by-line twin:

- RLS covers org isolation, the password gate, auditor deletes, manager-only
  reads of injuries and illnesses, anonymous token-bound reports, locks, and
  observations, append-only audit logs, and the permissive-union and
  post-state cases. It does not reproduce every permit and LOTO decision
  matrix in `firestore.rules`.
- `supabase` is still reserved. Supabase Auth is an IdP and does not select
  that driver.
- Moving an existing WEEHS tenant onto a company database, and the reverse,
  is still the unbuilt migration below.
- WhatsApp on the shared Firebase project is unchanged. The own-stack host
  does not yet run that channel. Mail sends when the host is given a
  transport; without `SMTP_PASS` it reports that mail was not sent.
- App Check's replacement for anonymous routes is still the company's choice.
  The token-bound policies exist. The vendor does not.

`node stack/demo-provision.mjs` builds one embedded company on
`http://127.0.0.1:8787`. It does not touch the shared Firebase project.

### Call-site traps the contract already names

From `src/shared/data/README.md`, still in force:

- `deleteDoc(d.ref)` becomes `remove(path, row.id)`. The provider returns a
  plain row and no ref.
- Fire's read-only demo guard wraps the raw write primitives at the import
  site. Moving the calls and leaving the guard behind drops the guard.
- Do not normalise timestamps inside the adapter.

## Migration order

This list is the build plan. A dedicated postgres host serves that company
after fulfillment. It does not serve them from the shared Firebase build, and
it does not serve an engine whose adapter is still reserved. The registration
choice is the product intent. Filing the request is not itself the cutover.

1. Keep serving users from the WEEHS Firebase deployment. Do the path 3 work
   in another environment. Do not move a `v*` tag. The database choice is on
   `RegisterOrg.jsx`. The own-stack branch files a provisioning request and
   does not call `registerOrganization`. That request is not a running stack.
   Do not set `VITE_DATA_DRIVER` to a reserved name on the strength of it.
2. Design the auth session so RLS and the presign endpoint can prove `uid`,
   org, role, approval, and the password-change gate. The first own-stack
   IdPs are OIDC, SAML, and Supabase Auth. In-app TOTP on that branch is
   optional and off unless the company turns it on.
3. Translate `firestore.rules` and `storage.rules` into RLS, bucket policy,
   and presign checks. Land the hostile tests before any adapter writes
   real data.
4. Move `orgData.js` and `src/shared/docId/` . The audit log and the
   reference numbers are safety properties, and `createModuleService`
   already depends on the second.
5. Move the module libraries, incidents / fire / LOTO / permit to work
   first, each library together with the dashboard path for that
   collection. Fix `module-kit`'s empty-on-error subscribe in that change.
6. Move `documents/lib/service.js`'s subscribe. The writes are already on
   the seam.
7. Move the public and field routes together with the policies that bind
   an anonymous write to its token.
8. Move the remaining shared readers: entitlements, platform admin,
   integrations, the alert feed, live stats, the crypto backfill,
   provisioning.
9. Rehost the "before cutover" jobs, especially `getDataKeys`,
   `deleteOrgFile`, subject export, retention, and the jobs that withdraw
   stale permit and LOTO mirrors.
10. Register the adapter in `DRIVERS`, point the contract assertions in
    `adapters/memory.test.js` at it (that file says they should hold for
    any other adapter), and remove the name from `RESERVED_DATA_DRIVERS`.
    Then set `VITE_DATA_DRIVER` in that environment's build.
11. Migrate data, sealed fields included, without changing the timestamp
    shape. Read `docs/DATA-RIGHTS.md` §2 before any search for a person.

`VITE_STORAGE_DRIVER=s3` may land earlier, as a file-store swap, under the
constraints in the file section. It does not unblock the data driver.

## Onboarding an organization that chose its own database

The procedure for deploying one company's dedicated environment on Cloud Run
with a managed Postgres — commands, secrets, and the limits to read first — is
[`CONTROL-PLANE.md`](CONTROL-PLANE.md). What follows is the reasoning.

The choice is made at registration, by the person founding the organization.
Choosing the WEEHS database creates a WEEHS organization. Choosing an own
database files a provisioning request and stops. The steps below are what the
operator does **after** that request, when the rest of this plan can serve
the company. They are not a way to serve that company on path 3 from the
request alone.

1. If the organization chose the WEEHS database, stop. Use the private
   production runbook (`docs/PRODUCTION.md`) and `DEPLOYMENT.md`. The shared
   suite is already that choice.
2. From the provisioning request, record the non-secret answers (which of
   the three hosting modes, auth method, issuer, bucket, presign URL) in that
   environment's deploy config. Credentials go to the secret manager or a
   gitignored env file, through the secure channel, not through the wizard
   and not into a client-readable document.
3. Provision the database in the hosting mode the request records, for the
   engine it names. Brought: attach to the company's database, whatever
   engine they chose. Postgres, including Supabase's Postgres, is driver
   `postgres` unless they need the Supabase client flavor (`supabase`).
   Another engine waits until its adapter is registered as above. Company
   cloud account, and WEEHS-operated: create Postgres. The bucket follows
   the same hosting mode. All three modes are offered; the request picks
   one mode and one engine.
4. Create two database roles where the engine has roles. The browser role
   is the one the future adapter will use, and the database's own policies
   apply to it. The bypass role is for migrations and the workers (key
   release, retention). Its URL is a secret. On the `supabase` flavor the
   anon key may ship in the client, and only because row level security is
   the boundary; the service-role key may not. On `postgres` there is no
   anon key: the browser still does not receive the bypass URL. Turn the
   policy layer on for every table that browser role can see.
5. Host the presign endpoint specified in `adapters/s3.js`. It checks the
   session and the `orgs/<orgId>/` prefix, it holds the S3 secret, and a
   delete re-reads the member's profile.
6. Set `VITE_DATA_DRIVER=postgres` only on that company's build, and only
   after the adapter is the one in `DRIVERS` (it is). `supabase` still
   fails the app at startup with `UnimplementedDataDriverError`. That
   failure is the control that stops a build writing into Firestore while
   labelled as something else. The error is in the browser console, and
   the value was compiled in, so clearing it means rebuilding. Do not set
   `postgres` on the shared Firebase production build.
7. If you set `VITE_STORAGE_DRIVER=s3` before the database has moved, tell
   the organization the files are in their bucket and the records are
   still in Firestore. The presign call still presents a Firebase ID
   token until Auth is replaced. A failed presign still inlines the file
   into the Firestore document.
8. Wire the auth method from the request (company OIDC, SAML, or Supabase
   Auth). Map its session onto `uid`, org, role, and approval. Do not also
   create WEEHS Firebase users for that organization. In-app TOTP is optional
   on this branch and off unless the company turns it on. Do not create a
   temporary WEEHS account so the founder can watch the request. Status goes
   by email.
9. Do not load production data, and do not point the Firebase seed scripts
   at the new database. They speak Firebase, not the company's engine.
10. When the remaining-work list is empty and the hostile policy tests
    exist, build that environment with the driver flags and deploy it as
    its own target. Leave the Firebase production tags where they are.

The control plane (`stack/server.mjs`, or `node stack/demo-provision.mjs`
for one local company) emails the handoff contact a one-time link when mail
is configured. Submitting that page fulfills a postgres request: status
`live`, dedicated URL assigned, ready mail sent. The wizard on the shared
suite still only files the non-secret Firestore request. It does not set
`VITE_DATA_DRIVER=postgres` on the shared Firebase build. `POST /fulfill`
retries fulfillment after secrets are already stored. `supabase` as a data
driver, a full translation of every Firestore decision matrix, and moving
an existing WEEHS tenant across stacks are still open. The shared Firebase
production tags stay where they are.

For company SAML the host is the service provider: `GET /auth/start` sends the
browser to the entry point from the handoff, and `POST /auth/saml` accepts a
response only if it is signed by the handoff's IdP certificate and answers an
AuthnRequest this host issued, once. `node e2e/record/own-stack-walkthrough.mjs`
drives the whole path — wizard, handoff, SAML sign-in, a logo into the
company's bucket, sign-out — against local stand-ins for the company's IdP and
bucket, and records it to `recordings/`.

## Moving between the WEEHS database and the company's database

This move is part of the design, in either direction. It is not built. It is
not a field on the organization, and the SPA does not pick a stack at
runtime while both exist.

People keep using the source URL until the cutover. The destination URL
starts serving when the move is finished, and not before. Two live copies
that both accept writes are not a migration.

What moves: the organization profile, the people, the module records, the
files, and the audit log. Sealed fields are re-wrapped under the destination
master by someone entitled to open them on the source. The WEEHS master does
not become the company's master, and the company's master is not copied into
the shared suite. `docs/DATA-RIGHTS.md` §2 still applies: reading ciphertext
and finding nothing is not a search.

Identities are created on the destination IdP. A move onto the company's
stack enrolls people in that company's IdP. A move back onto the WEEHS
database creates WEEHS Auth users. That destination account is not the
temporary WEEHS account a pending request does not get.

The module set follows the destination. On the company's database, the
company decides and their database enforces it. On the WEEHS database,
`/platform` decides. The move does not copy a module flag onto
`organizations/{orgId}` in the shared suite. That document is writable by
the organization's admin, which is why the entitlement does not live there
(`docs/PLATFORM-CONSOLE.md`).

The engine can change in the same move. A company leaving Firestore for
MySQL waits on that engine's adapter the same way a new own-stack request
does. Driver `postgres` is the generic Postgres destination, including a
Supabase Postgres that does not need the Supabase client. Driver `supabase`
is only the Supabase client flavor.

## Decisions

These are locked.

1. **Anyone registering may request their own database.** No prior agreement
   is required to ask. Filing the request reserves the organization name, so
   a second person cannot register a WEEHS tenant or a second own-stack
   request under it. `findOrgByName` can then say the name is taken and which
   door it uses. A request is not a live stack: nothing is served until that
   company's environment exists and the gap list is done.
2. **All three hosting modes are offered.** The company brings any
   database. WEEHS provisions Postgres, the generic driver, in the
   company's cloud account. WEEHS operates a dedicated project, also
   Postgres, for that company alone. Supabase is one flavor a company may
   bring, not the only store. The wizard records the mode and the engine.
   Credentials for all three still arrive through the secure channel, not
   through the form.
3. **Each own-stack company has its own environment and its own URL.** The
   shared SPA does not send that company to a different database after
   login. Their users use their URL. One environment, one driver, which is
   the seam in `src/shared/data/index.js`.
4. **That company alone holds `DATA_KEY_MASTER`.** It is not the shared
   suite's master, and it is not copied into the shared suite's secret
   store. The key-release worker on their environment reads their secret.
   Losing it destroys the sealed records on that stack and nowhere else.
   The master still never ships to the browser. When the mode is
   "WEEHS operates the project", the secret lives in that project's store
   because the worker has to read it there; it is still that company's
   secret, not a WEEHS escrow of the shared suite's key.
5. **The data store is any database the company chooses.** `postgres` is
   the generic driver, for Postgres-protocol servers including a Supabase
   Postgres they do not need the Supabase client for. `supabase` is one
   flavor, used when that client and Realtime are how the environment
   talks to the database. Other engines register their own adapter, by the
   steps under "Registering another engine". Supabase Auth is an IdP. It
   does not select the driver.
6. **While a request is `requested`, status is email only.** No sign-in
   until that company's IdP is live. No temporary WEEHS account.
7. **An own-stack company controls which modules it may use.** `/platform`
   does not. The company's database enforces the set. On the WEEHS
   database, `/platform` still decides (`docs/PLATFORM-CONSOLE.md`).
8. **Moving between the WEEHS database and the company's database is in
   this design**, in either direction. It is the migration in the section
   above. It is not a runtime toggle.
9. **The first wizard offers OIDC, SAML, and Supabase Auth.** All three.
   Supabase Auth does not imply the `supabase` data driver. In-app TOTP on
   the own-stack branch is optional and off unless the company turns it
   on, including when the IdP already performs MFA. WEEHS admins stay on
   the WEEHS TOTP requirement (`docs/ENTERPRISE-READINESS.md`).

Nothing in this list is still open.
