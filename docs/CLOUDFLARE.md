# Deploying on Cloudflare

Two ways, chosen by the Worker's settings in `wrangler.jsonc`:

- **A. Everything on Cloudflare** (no server to manage). The Worker serves the
  app *and* runs the server (`worker/server.js`). The database is
  **Cloudflare D1** (SQLite); uploaded files go to an **R2** bucket.
  `ORIGIN_URL` is empty and the `DB` binding is set. This is how the current
  deployment runs.
- **B. Cloudflare in front of your own server** (below, from "What you need").
  The Worker serves the app and forwards server requests through a Cloudflare
  Tunnel to the server in `selfhost/`. `ORIGIN_URL` is the Tunnel hostname.

## A. Everything on Cloudflare

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
   and uncomment the `r2_buckets` entry in `wrangler.jsonc`. Without it the
   app still works, keeping each photo or document (up to 700 KB) inside its
   record.
4. **Secrets**, each with `npx wrangler secret put NAME`:
   `SESSION_SECRET` (`openssl rand -hex 32`), `DATA_KEY_MASTER`
   (`openssl rand -base64 32`), and for the first start `ADMIN_EMAIL` and
   `ADMIN_PASSWORD` (at least 10 characters). Keep a copy somewhere safe:
   losing `DATA_KEY_MASTER` loses encrypted fields.
5. **Password-reset email (optional).** Create a Resend account
   (resend.com), verify the sending domain there (it gives DNS records to
   add), create an API key, then set `MAIL_FROM` in `wrangler.jsonc` (for
   example `Cult Fit SMS <noreply@curefit.com>`) and
   `npx wrangler secret put RESEND_API_KEY`. The sign-in page then offers
   **Forgot password?**, which emails a one-time link valid for 30 minutes.
   Without it, administrators reset passwords from Employees.
6. **Address.** `PUBLIC_ORIGIN` in `wrangler.jsonc` is the address people
   type (the `workers.dev` URL, or a custom domain added under the Worker's
   Settings → Domains & Routes).
7. **Deploy:** `npm run deploy:cloudflare`. Check
   `curl -s https://<address>/health` — it answers
   `{"ok":true,"database":"ok",…}`, or says what is missing.
8. **Sign in** at `https://<address>` with `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
   The organization (`ORG_NAME` in `wrangler.jsonc`) and this first
   administrator are created on the first request; you are asked to choose
   your own password straight away. Then add people under **Employees → Add
   employee**: each gets a temporary password to change at first sign-in.
   A forgotten password is reset by an administrator (Employees → Reset
   password).

Limits of A: the only mail sent is password-reset links; D1 holds up to
10 GB per database and runs one write at a time, which is ample for one
organization.

**Backups (A).** D1 keeps 30 days of point-in-time history (Time Travel):
`npx wrangler d1 time-travel restore ohsms --timestamp <time>`. For a copy
you hold yourself: `npx wrangler d1 export ohsms --remote --output ohsms.sql`.

## B. Cloudflare in front of your own server

OHSMS runs for **one organization**, on **that organization's server and
Postgres database**. Cloudflare sits in front of it:

```
 browser ──https──▶  Cloudflare Worker  (ehs.example.com)
                      │  serves the app (dist/) from Cloudflare's edge
                      │  forwards /data /auth/* /rpc/* /presign /blob
                      │           /scim/* /health /runtime-config.js
                      ▼
                     Cloudflare Tunnel  (ehs-origin.example.com, Access-protected)
                      │  outbound-only connection, no open ports on the server
                      ▼
           organization's server:  cloudflared ─▶ app (stack/, :8080) ─▶ SQLite file
                                                   └─ uploaded files on disk
```

The browser only ever talks to `ehs.example.com`, so sign-in cookies, the
`#session` redirect and every API call are same-origin. The server never needs
an inbound port.

There is a simpler variant: skip the Worker and point the Tunnel's public
hostname straight at `ehs.example.com`. The server already serves the built
app itself. Use the Worker when you want the app's static files cached at the
edge and the server reached only for data.

Everything below uses placeholders (`ehs.example.com`, `ehs-origin.example.com`).
Keep real hostnames, tokens and secrets out of the repository.

## What you need

- A Cloudflare account with the organization's domain on it (DNS managed by
  Cloudflare).
- A Linux server (VM or on-premises) with Docker and the Docker Compose plugin:
  2 vCPU, 4 GB RAM, 40 GB disk is comfortable for a few hundred users.
- Node 22 on the machine you deploy the Worker from (or use Cloudflare's Git
  integration, step 5).

## 1. Build the server image

From the repository root:

```bash
docker build -f stack/Dockerfile -t ohsms-server:3.0.0 .
```

Push it to a registry the server can pull from, or build it on the server
itself. The image contains the server (`stack/`) and a copy of the built app.

## 2. Create the Tunnel

Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel**
(type _Cloudflared_). Name it, for example `ohsms`. Copy the **tunnel token**
it shows under _Install connector_. You do not run the install command it
suggests: compose runs `cloudflared` for you.

Under **Public hostnames**, add:

| Subdomain / domain       | Service             |
| ------------------------ | ------------------- |
| `ehs-origin.example.com` | `HTTP` → `app:8080` |

`app` is the server's name inside the compose network.

**Protect the origin hostname with Cloudflare Access**, so only the Worker can
reach it: Zero Trust → **Access → Applications → Add → Self-hosted** for
`ehs-origin.example.com`, with a policy of action **Service Auth** that allows
one **service token** (Access → Service credentials → Service tokens → Create).
Keep the token's Client ID and Client Secret for step 5.

## 3. Install on the server

Copy the `selfhost/` folder to the server, then:

```bash
cd selfhost && cp .env.example .env && chmod 600 .env
```

Fill in `.env`:

- `WEEHS_IMAGE` — the image from step 1.
- `COMPOSE_PROFILES=cloudflare`
- `DOMAIN=ehs.example.com` — the **Worker's** hostname, the one people type.
  The server builds every file link on it.
- `TUNNEL_TOKEN` — from step 2.
- `DATA_KEY_MASTER` — `openssl rand -base64 32`.
- `SESSION_SECRET` — `openssl rand -hex 32`.
- `ADMIN_EMAIL`, `ADMIN_PASSWORD` — the first administrator (first start only).
- Optionally the `SMTP_` settings and `MAIL_FROM`, for invitation mail.

**Back up `.env` somewhere off the server.** Without `DATA_KEY_MASTER`
encrypted fields cannot be opened.

Start it:

```bash
docker compose up -d
```

```bash
docker compose ps
```

The app and `cloudflared` should be running, and the tunnel should
show **Healthy** in the dashboard. Caddy does not start with the `cloudflare`
profile, and nothing listens on a public port.

## 4. Point the Worker at the server

`wrangler.jsonc` has one setting to change:

```jsonc
"vars": { "ORIGIN_URL": "https://ehs-origin.example.com" }
```

Then store the Access service token as Worker secrets (asked for
interactively; never put them in the file):

```bash
npx wrangler secret put CF_ACCESS_CLIENT_ID
```

```bash
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
```

## 5. Deploy the Worker

From a checkout, signed in with `npx wrangler login`:

```bash
npm ci
```

```bash
npm run deploy:cloudflare
```

That builds the app (`dist/`) and deploys `worker/index.js` with it. Or connect
the repository in the Cloudflare dashboard (**Workers & Pages → Create → Import
a repository**) with build command `npm ci && npm run build` and deploy command
`npx wrangler deploy`; every push to `main` then redeploys the Worker.

Finally give the Worker its address: Worker → **Settings → Domains & Routes →
Add → Custom domain** → `ehs.example.com`.

Check:

```bash
curl -s https://ehs.example.com/health
```

It answers `{"ok":true}` — that request went browser → Worker → Tunnel → server.

## 6. Sign in

Open `https://ehs.example.com` and sign in with `ADMIN_EMAIL` and
`ADMIN_PASSWORD`. The organization and this first administrator were created
when the server started; you are asked to choose your own password straight
away. From there:

1. **Settings** — organization details, departments, scope and granularity.
2. **Sites** — add sites, including latitude and longitude.
3. **Employees → Add employee** — each person gets a temporary password to
   change at first sign-in. **Reset password** on the same page handles a
   forgotten one.

## Updating

- **App only** (UI change): redeploy the Worker (step 5).
- **Server** (anything under `stack/`, or the schema): build a new image, set
  `WEEHS_IMAGE` in `.env`, then `docker compose up -d`. The server applies its
  schema on start; it never needs a manual migration step.

Deploy the server first when a change touches both, so the app never calls a
route the server does not have yet.

## Backups

Back up two things, together:

1. The `data` volume — the database file (`ohsms.sqlite`) and uploaded files.
   For a consistent copy while running:
   `docker compose exec app node -e "new (require('node:sqlite').DatabaseSync)('/srv/stack/data/ohsms.sqlite').exec(\"VACUUM INTO '/srv/stack/data/backup.sqlite'\")"`
   then copy `backup.sqlite` and the `files/` folder off the server.
2. `.env` — the keys.

A backup is only real once it has been restored somewhere else and signed in to.

## Troubleshooting

| Symptom                                                 | Likely cause                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/health` answers 503 `ORIGIN_URL is not configured`    | `ORIGIN_URL` missing or not `https://` in `wrangler.jsonc`                                         |
| `/health` answers 403 from Cloudflare Access            | Worker secrets `CF_ACCESS_CLIENT_ID` / `_SECRET` missing or wrong                                  |
| `/health` answers 502/530                               | Tunnel down: `docker compose logs cloudflared`, or the hostname's service is not `http://app:8080` |
| Sign-in returns to the IdP with "redirect URI mismatch" | `DOMAIN` in `.env` is not the Worker hostname, or the IdP has another callback registered          |
| Sign-in says "That email and password do not match" for the admin | the server started without `ADMIN_EMAIL`/`ADMIN_PASSWORD`, or an admin already existed |
| Uploads fail                                            | the `files` volume is not writable, or the upload is over 30 MB                                    |
