# Deployment

OHSMS runs for **one organization** on Cloudflare: one Worker, its own D1
database and its own private R2 bucket. There is no shared or multi-tenant
service, and no server to manage. The procedure is
[`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md).

## The pieces

- **`src/`** — the web app (React + Vite). Built to `dist/`.
- **`stack/`** — the organization's server logic: email-and-password sign-in
  (`/auth/password`, `stack/passwords.mjs`), the data gateway (`/data`,
  enforced by `stack/policy.mjs` on every read and write), server jobs
  (`/rpc/*`), and file links (`/presign`, `/blob`). Production runs it inside
  the Worker; `npm run dev:local` runs it on your machine
  ([`docs/LOCAL-DEVELOPMENT.md`](docs/LOCAL-DEVELOPMENT.md)).
- **`worker/`** — the Cloudflare Worker: serves `dist/` and runs the server
  (D1 + R2), plus the scheduled jobs from the cron triggers in
  `wrangler.jsonc`.

## First organization

There is exactly one. It is created on the first request, with its first
administrator (`ADMIN_EMAIL` / `ADMIN_PASSWORD`). Everyone else is added from
**Employees → Add employee**, each with a temporary password; **Reset
password** on the same page handles forgotten ones.

## After each deploy

- Open the "Deploy OHSMS" run and check that the deploy step ran, not only
  that the run is green (`docs/CLOUDFLARE.md`, Deploying main from GitHub).
- `curl -s https://ehs.example.com/health` answers `{"ok":true,…}`.
- Sign in; open a few modules (Incidents, Inspections, Permits, LOTO,
  Training). Upload a photo and open it again.
- In DevTools, watch for `permission-denied` on `/data` — that is the
  server's access rules (`stack/policy.mjs`) refusing a read the screen expected.

## Rollback

- **Worker:** Cloudflare dashboard → the Worker → **Deployments** → roll back
  to the previous version (instant). Schema changes are additive, so an older
  Worker reads the newer database.
- **Data:** D1 Time Travel restores the database to any point in the last 30
  days (`docs/CLOUDFLARE.md`, Backups).
