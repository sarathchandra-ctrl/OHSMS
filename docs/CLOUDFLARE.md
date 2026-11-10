# Deploying on Cloudflare

OHSMS runs entirely on Cloudflare, with no server to manage. The Worker
(`worker/index.js`) serves the app from the edge and runs the organization's
server itself (`worker/server.js`, the same handler as `stack/handler.mjs`).
The database is **Cloudflare D1** (SQLite) and uploaded files go to a private
**R2** bucket.

## Setting up

**Plan: Workers Paid ($5 a month) is required.** The Free plan does not
fit this server, for three reasons that each fail in front of users:

- **CPU time.** Free allows 10 ms of CPU per request. One password check
  (PBKDF2-SHA256 at 100,000 iterations, the most Workers allows) takes about
  20 ms, so sign-in, password changes and resets fail with error 1102. Paid
  allows 30 seconds.
- **Queries per invocation.** Free allows 50 D1 queries in one request or
  cron run, Paid 1,000. The nightly jobs save one record at a time, so on
  Free a Recycle Bin of a dozen or so items stops the purge part-way.
- **Daily D1 quotas.** Since 1 September 2026 Free accounts get hard errors
  after 100,000 rows written or 5 million rows read in a day, until midnight
  UTC. The five-minute LOTO sweep reads every LOTO permit, around the clock.

1. **Database.** Create a D1 database near your users:
   ```bash
   npx wrangler d1 create ohsms --location apac
   ```
   and put its `database_id` in `wrangler.jsonc` under `d1_databases`. The
   Worker creates its tables on the first request; there is nothing to run by
   hand. Access rules are enforced by `stack/policy.mjs` before any SQL runs
   (D1 has no row-level security of its own).
2. **First administrator.** `ADMIN_EMAIL` and `ADMIN_PASSWORD` (secrets,
   below). `ADMIN_MUST_CHANGE` in `wrangler.jsonc` is `"false"` when you chose
   the password yourself, `"true"` to force a change at first sign-in.
3. **Files.** Enable R2 on the account (Cloudflare → R2, accept the terms),
   then:
   ```bash
   npx wrangler r2 bucket create ohsms-files
   ```
   `wrangler.jsonc` binds that private bucket as `FILES`. Keep public access
   disabled: the Worker signs upload and download links and checks them before
   accessing R2. Attachments may be up to **2 MB (2,097,152 bytes)** each; the
   upload endpoint counts the actual body and rejects larger files. Sealed
   files reserve an additional 16 bytes for their AES-GCM authentication tag.
   Existing inline attachments remain readable; files are not migrated automatically.
   After deploying, `/health` must include `"files":true`.
4. **Secrets**, each with `npx wrangler secret put NAME`:
   `SESSION_SECRET` (`openssl rand -hex 32`), `DATA_KEY_MASTER`
   (`openssl rand -base64 32`), and for the first start `ADMIN_EMAIL` and
   `ADMIN_PASSWORD` (at least 10 characters). Keep a copy somewhere safe:
   losing `DATA_KEY_MASTER` loses encrypted fields and every person's
   two-step login setup.
5. **Email (optional).** Create a Resend account
   (resend.com), verify the sending domain there (it gives DNS records to
   add), create an API key, then set `MAIL_FROM` in `wrangler.jsonc` (for
   example `OHSMS <noreply@example.com>`) and
   `npx wrangler secret put RESEND_API_KEY`. The sign-in page then offers
   **Forgot password?**, which emails a one-time link valid for 30 minutes,
   and the server starts sending notifications (below). Without it,
   administrators reset passwords from Employees and no notification is
   sent.
6. **Address.** `PUBLIC_ORIGIN` is the address people type (the
   `workers.dev` URL, or a custom domain added under the Worker's Settings →
   Domains & Routes). It is **not** in `wrangler.jsonc`: the repository is
   public and the live hostname stays with the operator. Set it on the
   Worker, either with the first deploy (step 7) or under Settings →
   Variables and Secrets. `"keep_vars": true` in `wrangler.jsonc` stops
   later deploys from deleting it. Until it is set the server answers 503
   `the server is not configured: PUBLIC_ORIGIN`.
7. **Deploy.** The first time:
   ```bash
   npm run build && npx wrangler deploy --var PUBLIC_ORIGIN:https://<address>
   ```
   and after that `npm run deploy:cloudflare`. Check
   `curl -s https://<address>/health` — it answers
   `{"ok":true,"database":"ok",…}`, or says what is missing.
8. **Sign in** at `https://<address>` with `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
   The organization (`ORG_NAME` in `wrangler.jsonc`) and this first
   administrator are created on the first request; you are asked to choose
   your own password straight away. Then add people under **Employees → Add
   employee**: each gets a temporary password to change at first sign-in.
   A forgotten password is reset by an administrator (Employees → Reset
   password).

Limits: the only mail sent is password-reset links; D1 holds up to
10 GB per database and runs one write at a time, which is ample for one
organization. One record may be at most 1,900,000 bytes, under D1's
2,000,000-byte row limit (`MAX_RECORD_BYTES` in `stack/engine.mjs`); a larger
save is refused with `record too large` rather than failing inside D1. Files
belong in R2, not inside records.

**Scheduled jobs.** `wrangler.jsonc` sets three cron triggers that run the
server's own jobs (`stack/schedule.mjs`): LOTO due/overdue flags every five
minutes, and nightly at 03:45 IST the Recycle Bin purge, the purge of LOTO
permits closed more than a year ago, and the withdrawal of stale public permit
pages; and at 08:00 IST each person's daily summary email, when mail is set
up. They deploy with the Worker. A run that hit a problem shows as a failed
invocation under the Worker's logs.

**Notifications.** A save that needs someone's attention puts an item in
their bell (top of every page; all of them at `/notifications`, each opening
the record it is about) and, with mail set up, mails them, right after it is
answered (`stack/notify.mjs`, rules in
`stack/lib/notify.js`): a new incident to the site's managers and the
organization's notification email, a corrective action to its owner, a new
permit to its approvers, audit findings between auditee and auditor, and
training to the person assigned it. Each kind can be switched off under
Admin → Organization settings → Notifications; all are on until then. A mail
carries a reference, a site, a date and a link, never a narrative or anything
medical; illness reports are not mailed. People opt out of the daily summary
under Account security. **Send today's summaries now**, on the same card,
is for checking a new set-up; each person still gets at most one a day.

**Backups.** D1 keeps 30 days of point-in-time history (Time Travel):
`npx wrangler d1 time-travel restore ohsms --timestamp <time>`. For a copy
you hold yourself: `npx wrangler d1 export ohsms --remote --output ohsms.sql`.

## Deploying main from GitHub

`.github/workflows/deploy-cloudflare.yml` deploys the `main` branch to the
existing **ohsms** Worker on every push, and can also be run from Actions.
It does not deploy the separate sms Worker.

Before the first run, in GitHub **Settings → Secrets and variables → Actions**,
add three repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
and `OHSMS_PUBLIC_ORIGIN` (the Worker's address, `https://<address>`). The
address is a secret rather than a variable so that GitHub masks it in this
public repository's Actions logs, including where `wrangler deploy` prints the
URL. The workflow passes it to the Worker as `PUBLIC_ORIGIN` on every deploy
and checks `/health` there. Use an API token scoped to the intended account that can deploy Workers and
access the configured D1 and R2 resources. Enter credentials in GitHub's secure
settings, never in a source file or issue.

The existing D1 database and the private R2 bucket declared in `wrangler.jsonc`
must exist. Keep the Worker's existing `SESSION_SECRET` and `DATA_KEY_MASTER`
unchanged. Worker secrets are separate from GitHub's deployment credentials.
Email reset also needs `RESEND_API_KEY` and a verified `MAIL_FROM` setting.

The workflow installs locked dependencies, runs lint and tests, builds the app,
and deploys its assets and backend together. It then checks `/health` for the
database, storage binding and deployed Git commit.

Until all three secrets exist the job **skips** the build and deploy and
still shows as passed, with a notice saying why. A green run is therefore not
proof of a live deployment: open the run and check that "Build and deploy the
ohsms Worker" ran. After supplying secrets, use **Actions → Deploy OHSMS → Run
workflow**, branch `main`.

## Updating

Push to `main` (or run the workflow). The app and the server deploy together
as one Worker, so the app never calls a route the server does not have. The
Worker applies its schema on the first request after a deploy; there is no
manual migration step.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `/health` answers 503 `not configured: PUBLIC_ORIGIN` | the address was never set on the Worker: deploy once with `--var PUBLIC_ORIGIN:https://<address>`, or set it under Settings → Variables and Secrets |
| `/health` answers 503 `The DB binding is not configured` | the `d1_databases` binding is missing or misnamed in `wrangler.jsonc` |
| `/health` does not include `"files":true` | the `FILES` R2 binding is missing, or R2 is not enabled on the account |
| Sign-in says "That email and password do not match" for the admin | the Worker started without `ADMIN_EMAIL`/`ADMIN_PASSWORD`, or an admin already existed |
| Sign-in fails with error 1102 | the account is on Workers Free; a password check needs more CPU than Free allows (see Setting up) |
| A save fails with `record too large` | the record is over 1,900,000 bytes; attach files through R2 rather than inside the record |
| Uploads fail | the R2 binding is missing, or the attachment is over 2 MB |
| The deploy run is green but nothing changed | the deployment secrets are not set, so the deploy step was skipped (see above) |
