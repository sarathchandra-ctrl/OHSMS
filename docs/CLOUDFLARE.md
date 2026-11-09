# Deploying on Cloudflare

Two ways, chosen by the Worker's settings in `wrangler.jsonc`:

- **A. Everything on Cloudflare** (no server to manage). The Worker serves the
  app *and* runs the server (`worker/server.js`). Postgres is reached through
  a **Hyperdrive** config; uploaded files go to an **R2** bucket. `ORIGIN_URL`
  is empty and the `HYPERDRIVE` binding is set. This is how the current
  deployment runs.
- **B. Cloudflare in front of your own server** (below, from "What you need").
  The Worker serves the app and forwards server requests through a Cloudflare
  Tunnel to the server in `selfhost/`. `ORIGIN_URL` is the Tunnel hostname.

## A. Everything on Cloudflare

1. **Postgres.** Create the database (PlanetScale, Neon, Supabase, RDS…) and a
   Hyperdrive config for it (Cloudflare → Storage & Databases → Hyperdrive).
   Put its id in `wrangler.jsonc` under `hyperdrive`.
2. **One-time database roles.** Most hosted databases do not let the app's
   user create roles. Run [`stack/planetscale-setup.sql`](../stack/planetscale-setup.sql)
   once in the database's console as its administrator, with `APP_USER` set to
   the user the Hyperdrive config connects as. The Worker creates every table,
   policy and function itself on its first request after that, and again
   after any deploy that changes `stack/schema.sql`.
3. **Files.** Enable R2 on the account (Cloudflare → R2, accept the terms),
   then:
   ```bash
   npx wrangler r2 bucket create ohsms-files
   ```
   and uncomment the `r2_buckets` entry in `wrangler.jsonc`. Without it the
   app still works, keeping each photo or document (up to 700 KB) inside its
   record.
4. **Secrets.** `SESSION_SECRET` and `CONTROL_TOKEN` (`openssl rand -hex 32`),
   `STATE_KEY` and `DATA_KEY_MASTER` (`openssl rand -base64 32`), each with
   `npx wrangler secret put NAME`. Keep a copy somewhere safe: losing
   `STATE_KEY` loses the sign-in configuration, losing `DATA_KEY_MASTER` loses
   encrypted fields.
5. **Address.** `PUBLIC_ORIGIN` in `wrangler.jsonc` is the address people
   type (the `workers.dev` URL, or a custom domain added under the Worker's
   Settings → Domains & Routes).
6. **Deploy:** `npm run deploy:cloudflare`. Check
   `curl -s https://<address>/health` — it answers
   `{"ok":true,"database":"ok",…}`, or says what is missing.
7. **Set up:** open `https://<address>/setup` with `CONTROL_TOKEN` as the
   setup code, and connect the company sign-in (OIDC or SAML).

Limits of A: invitation mail is not sent (no SMTP on Workers yet), and every
request opens its database connection through Hyperdrive, so pick a database
region close to Cloudflare's users.

## B. Cloudflare in front of your own server

OHSMS runs for **one organization**, on **that organization's server and
Postgres database**. Cloudflare sits in front of it:

```
 browser ──https──▶  Cloudflare Worker  (ehs.example.com)
                      │  serves the app (dist/) from Cloudflare's edge
                      │  forwards /data /auth/* /rpc/* /presign /blob /setup
                      │           /scim/* /health /runtime-config.js
                      ▼
                     Cloudflare Tunnel  (ehs-origin.example.com, Access-protected)
                      │  outbound-only connection, no open ports on the server
                      ▼
           organization's server:  cloudflared ─▶ app (stack/, :8080) ─▶ Postgres
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
- The organization's identity provider: OIDC (Okta, Microsoft Entra, Google,
  Keycloak…) or SAML. See "Known limits" in [`SELF-HOSTING.md`](SELF-HOSTING.md).
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
  The server builds every redirect, SAML/OIDC callback and file link on it.
- `TUNNEL_TOKEN` — from step 2.
- `DB_ADMIN_PASSWORD`, `APP_DB_PASSWORD` — `openssl rand -hex 24` each.
- `STATE_KEY`, `DATA_KEY_MASTER` — `openssl rand -base64 32` each.
- `CONTROL_TOKEN`, `SESSION_SECRET` — `openssl rand -hex 32` each.
- Optionally the `SMTP_` settings and `MAIL_FROM`, for invitation mail.

**Back up `.env` somewhere off the server.** Without `STATE_KEY` the stored
sign-in configuration cannot be read; without `DATA_KEY_MASTER` encrypted
fields cannot be opened; without the passwords the data cannot be reached.

Start it:

```bash
docker compose up -d
```

```bash
docker compose ps
```

Postgres, the app and `cloudflared` should be running, and the tunnel should
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

## 6. Set up the organization

Open `https://ehs.example.com/setup`. Enter the setup code (`CONTROL_TOKEN`
from `.env`), the organization's name, your name and work email, and the
identity provider. The page shows the exact callback URLs to register with the
provider:

- **SAML:** ACS / reply URL `https://ehs.example.com/auth/saml`, entity ID
  `https://ehs.example.com`, sign-on URL `https://ehs.example.com/auth/start`.
- **OIDC:** redirect URI `https://ehs.example.com/auth/callback`.

`/setup` runs once. It creates the organization and makes your email its
first administrator, then closes for good. Sign in at `https://ehs.example.com`
with your company account, and from there:

1. **Settings** — organization details, departments, scope and granularity.
2. **Sites** — add sites, including latitude and longitude.
3. **Employees → Invite** — invite people, or set _Join automatically_ by
   email domain, or map identity-provider groups to roles, or turn on SCIM.

## Updating

- **App only** (UI change): redeploy the Worker (step 5).
- **Server** (anything under `stack/`, or the schema): build a new image, set
  `WEEHS_IMAGE` in `.env`, then `docker compose up -d`. The server applies its
  schema on start; it never needs a manual migration step.

Deploy the server first when a change touches both, so the app never calls a
route the server does not have yet.

## Backups

Back up three things, together:

1. The database — for example nightly
   `docker compose exec -T db pg_dump -U postgres ehs > ehs-$(date +%F).sql`.
2. The `files` volume — uploaded photos and documents.
3. `.env` — the keys.

A backup is only real once it has been restored somewhere else and signed in to.

## Moving from the earlier multi-organization build

A database created by the earlier build (paths `organizations/<id>/…`) is
converted automatically the first time the new server starts against it:
records move to top-level collections, the organization becomes
`organization/profile`, and the tenant columns are dropped. It refuses to
start if the database holds more than one organization — move one per server.
Take a backup first.

Files that build stored outside this server (a separate bucket) are not moved;
records keep their old links.

## Troubleshooting

| Symptom                                                 | Likely cause                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/health` answers 503 `ORIGIN_URL is not configured`    | `ORIGIN_URL` missing or not `https://` in `wrangler.jsonc`                                         |
| `/health` answers 403 from Cloudflare Access            | Worker secrets `CF_ACCESS_CLIENT_ID` / `_SECRET` missing or wrong                                  |
| `/health` answers 502/530                               | Tunnel down: `docker compose logs cloudflared`, or the hostname's service is not `http://app:8080` |
| Sign-in returns to the IdP with "redirect URI mismatch" | `DOMAIN` in `.env` is not the Worker hostname, or the IdP has another callback registered          |
| Sign-in page says "Not set up yet"                      | `/setup` has not been completed                                                                    |
| Uploads fail                                            | the `files` volume is not writable, or the upload is over 30 MB                                    |
