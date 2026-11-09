# Self-hosting WEEHS on your own server

This runs WEEHS (OHSMS) for one organization on a computer or server with
Docker: a virtual machine on any cloud, or a server in your own building.
Your records and uploaded files stay on that server and its Postgres
database, and your people sign in with your own identity provider. There is
no shared service: one installation is one organization.

Everything is in [`selfhost/`](../selfhost): `install.sh` (sets it all up in
one command), `compose.yaml` (the app, Postgres, and an HTTPS front door),
`.env.example` (every setting), and `init-db.sh` (the one-time database
setup).

Two front doors, chosen by `COMPOSE_PROFILES` in `.env`:

- `caddy` (this page): HTTPS on the server itself, ports 80 and 443 open.
- `cloudflare`: Cloudflare in front, through a Cloudflare Tunnel, with no
  inbound ports. Follow [`CLOUDFLARE.md`](CLOUDFLARE.md).

## Install without a terminal (recommended)

Before you start: point your address (for example `ehs.example.com`) at the
server with a DNS record, and let web traffic (ports 80 and 443) reach it.

1. On the server, install **Docker**: Docker Desktop on Windows or macOS (an
   ordinary installer), Docker Engine on Linux.
2. From the release page, download the **WEEHS Installer** for the server
   (`weehs-installer-windows-x64.exe`, `weehs-installer-macos-arm64` or
   `weehs-installer-linux-x64`) and open it. The server's screen shows a
   one-time **installer code**.
3. On any computer, open `http://ehs.example.com`. The installer answers at
   your address:
   - **Installer code:** the one on the server's screen. Ten wrong codes lock
     it for fifteen minutes.
   - **Check the server:** Docker is running and the HTTPS port is free.
   - **Your address:** filled in from the one you opened; email optional.
   - **Install:** writes the settings with new secrets on the server and
     prepares WEEHS. Then **Download settings backup** (keep it somewhere
     safe, away from the server) and **Switch to HTTPS and finish**.
4. The installer hands the address to WEEHS, which takes it with HTTPS, and
   your browser lands on `https://ehs.example.com/setup` with the setup code
   already filled in: step 4 below.

Opening the installer again later starts WEEHS again with the same settings;
it never replaces the secrets of an existing install.

The installer is not code-signed yet, so Windows SmartScreen and macOS
Gatekeeper ask for confirmation the first time.

The rest of this page is the same install by command line, for servers
without a desktop.

## What you need

- A Linux server with **Docker** and the **Docker Compose plugin**. 2 vCPU,
  4 GB RAM and 40 GB disk are comfortable for a few hundred users.
- A **domain name** for it, for example `ehs.example.com`, with a DNS `A`
  record pointing at the server's public IP address.
- **Ports 80 and 443** open to the internet. Port 80 is needed for the free
  certificate; everything is served over 443.
- Your organization's **identity provider** details: SAML, or OIDC (Okta,
  Microsoft Entra, Google, Keycloak, …). See "Known limits" below.
- The **image** for the release you are installing, from the release page
  ([`RELEASES.md`](RELEASES.md)).
- Optional: SMTP details for outgoing mail.

## 1. Get the files

Download `weehs-VERSION-selfhost.tar.gz` from the release page onto the
server, for example into `/opt/weehs`, and unpack it:

```bash
cd /opt/weehs
```

```bash
tar xzf weehs-2.2.0-selfhost.tar.gz && cd weehs-selfhost-2.2.0/selfhost
```

## 2. Install

If the image is private (see "Who can download the image" in
`RELEASES.md`), sign in to the registry first with the token you were given:

```bash
docker login ghcr.io
```

Then one command, with your domain and the image from the release page:

```bash
./install.sh --domain ehs.example.com --image ghcr.io/OWNER/weehs-dedicated@sha256:DIGEST
```

It checks that Docker, Compose, `openssl` and `curl` are there, writes `.env`
with every secret freshly generated (readable by you only), starts the
database, the app and Caddy, waits until `https://ehs.example.com/health`
answers, and prints the status. The first start creates the database, the
two roles its security rules use, and an ordinary account for the app
(`init-db.sh`). Caddy obtains the HTTPS certificate, which can take a minute.

**Back up `.env` somewhere safe and separate from the server.** Without
`STATE_KEY` the stored secrets cannot be read and the app will not start;
without the database passwords the data cannot be reached.

Running `./install.sh` again, with or without options, never touches an
existing `.env`: it only starts what is there. So it is also how you start
again after a reboot or an upgrade. To add mail, fill in the `SMTP_`
settings and `MAIL_FROM` in `.env` and run it again.

Opening `https://ehs.example.com` shows **Not set up yet** until step 4.

## 3. Or by hand

What `install.sh` does, if you prefer to do it yourself. Copy the example:

```bash
cp .env.example .env
```

Fill in every value. The comments say what each is:

- `WEEHS_IMAGE`: the image from the release page, preferably the
  `@sha256:` digest form.
- `DOMAIN`: your domain, without `https://`.
- `DB_ADMIN_PASSWORD`, `APP_DB_PASSWORD`: `openssl rand -hex 24` each.
- `STATE_KEY`, `DATA_KEY_MASTER`: `openssl rand -base64 32` each.
- `CONTROL_TOKEN`, `SESSION_SECRET`: `openssl rand -hex 32` each.
- The `SMTP_` settings and `MAIL_FROM`, if you want mail.

Then make it readable only by the administrator, and start:

```bash
chmod 600 .env
```

```bash
docker compose up -d
```

Check:

```bash
docker compose ps
```

```bash
curl -s https://ehs.example.com/health
```

`/health` answers `{"ok":true}`.

## 4. Connect your organization, in the browser

Open `https://ehs.example.com/setup` (the sign-in page links to it while the
environment is not set up) and fill in:

- **Setup code:** `CONTROL_TOKEN` from `.env`.
- **Your organization:** its name and address, and your name and work email.
  You become the administrator.
- **How people sign in:** SAML or OpenID Connect. The page shows the values
  to register this application with in your identity provider (the SAML
  reply URL and entity ID, or the OIDC redirect URI), and asks for what the
  identity provider gives back: for SAML its sign-in URL and certificate, for
  OIDC the issuer URL, client ID and client secret.

**Set up and go live** creates the organization in this server's database
and connects the sign-in. Then sign in with your company account and, from
**Employees**, invite everyone else; from **Sites**, add your locations.

For an identity provider that already serves many apps, read "Known
limits" below:
where the app's tile in their portal should point, Microsoft Entra, and
**Join automatically**, which lets everyone at the company's email domain in
without an invite each.

`/setup` closes for good once the organization is live. Ten wrong setup codes
in fifteen minutes lock it for the rest of that window.

## Upgrading

When a new release is announced:

1. Read its release page for any action needed.
2. Back up the database (below).
3. Put the new image in `.env` (`WEEHS_IMAGE=…`).
4. Pull and restart (or run `./install.sh`, which keeps `.env` and starts):

```bash
docker compose pull
```

```bash
docker compose up -d
```

The database schema is updated automatically when the new version starts.
Never change `STATE_KEY` or `SESSION_SECRET` as part of an upgrade.

## Backups

Back up the database daily, and keep copies off the server:

```bash
docker compose exec -T db pg_dump -U postgres -Fc ehs > weehs-$(date +%F).dump
```

Uploaded photos and documents are in the `files` volume, not the database:
back that up too, for example with
`docker run --rm -v weehs_files:/f -v "$PWD":/b alpine tar czf /b/files-$(date +%F).tgz -C /f .`

Restore into a fresh install (same `.env`, empty database volume):

```bash
docker compose up -d db
```

```bash
docker compose exec -T db pg_restore -U postgres -d ehs --clean --if-exists < weehs-2026-01-01.dump
```

```bash
docker compose up -d
```

Test a restore before you need one. A backup that has never been restored is
a hope, not a backup.

## Everyday operation

- **Logs:** `docker compose logs -f app`
- **Stop:** `docker compose down` (data is kept). Never add `-v` unless you
  mean to delete the database.
- **Server updates:** keep the operating system and Docker patched; the
  database and app are not exposed to the internet, only Caddy is.
- **Disk:** watch free space; the database and its backups grow with use.

## Using a managed Postgres instead of the bundled one

Any Postgres 14+ works. Point `DATABASE_URL` at it and create the two roles
the schema needs once, as the instance's administrator: `ohsms_browser`, which
every request from the app runs as and which row-level security applies to,
and `ohsms_worker`, which bypasses it for server jobs.

```sql
CREATE ROLE ohsms_browser NOLOGIN;
CREATE ROLE ohsms_worker NOLOGIN BYPASSRLS;
GRANT ohsms_browser, ohsms_worker TO ehs_app;
ALTER DATABASE ehs OWNER TO ehs_app;
```

Then, connected to the `ehs` database as the administrator:

```sql
ALTER SCHEMA public OWNER TO ehs_app;
```

If `CREATE ROLE ... BYPASSRLS` is refused, the provider's admin role cannot
grant it; use a provider or tier that allows it. The server creates its tables
and policies itself, as `ehs_app`, every time it starts.

## Known limits

- **OIDC providers must vouch for the email.** The host reads the provider's
  discovery document, so Okta, Microsoft Entra, Google, Keycloak and others
  work. Invites are matched by email, so a sign-in is refused unless the
  provider says the address is verified (`email_verified: true`). Microsoft
  Entra does not send that claim at all: register the application as
  **single-tenant** (your organization only), so every `email` it sends is one
  your administrators set, and deploy with `OIDC_ACCEPT_UNVERIFIED_EMAIL=true`
  (or tick "Microsoft Entra ID, single tenant" on `/setup`, which stores the
  same choice with the sign-in configuration). Never for a multi-tenant
  registration, which admits accounts from other tenants whose email address
  nobody verified. An explicit `email_verified: false` is refused either way.
- **SAML sign-in starts at WEEHS, not at the portal.** Every SAML response
  must answer a request this host made (it is what stops a response captured
  elsewhere from being replayed here), so an IdP-initiated sign-in from the
  app's tile in Okta or "My Apps" is refused. Point the tile at
  `https://ehs.example.com/auth/start` instead: the Sign-on URL in Entra, a
  bookmark app in Okta. `/setup` shows the address. The same works for OIDC.
- **Who joins, and as what.** The IdP decides who can sign in; WEEHS decides
  who belongs. In Employees → Invite employee, an admin can:
  - invite people one by one;
  - **Join automatically**: anyone with an address at the listed domains
    joins with one role (never admin);
  - map **identity provider groups to roles** (`EHS-Admins` → Administrator,
    `Safety-Managers` → Manager): applied at every sign-in, so a change in
    the IdP shows at the person's next sign-in, and anyone in a mapped group
    joins without an invite. The most capable mapped role wins; no mapped
    group sent leaves the role as it is; a sign-in never moves the last
    administrator. Groups are read from a SAML `groups` or `memberOf`
    attribute or Entra's groups claim, and from OIDC `groups` in userinfo or
    the ID token. Entra sends group object IDs unless configured otherwise:
    map those IDs.
- **SCIM sync, and leaving.** **Turn on sync** in the same dialog gives a
  SCIM 2.0 base URL (`https://ehs.example.com/scim/v2`) and a bearer token,
  shown once, to enter in Okta or Entra as the app's provisioning.
  - Users: assigning someone the app invites them here; deactivating or
    removing them disables their account at once (an open session stops at
    its next request) and keeps them out even if their domain or a group
    would let them join; reactivating lets them in again.
  - Groups (Okta "Push Groups", Entra group provisioning): pushed groups and
    their members count like groups sent at sign-in, and a change applies to
    existing accounts at once. Entra signs people in with group object IDs;
    a group it has pushed carries that ID as its externalId, so rules can be
    written with the group's name.
- **Google Workspace.** OIDC (`https://accounts.google.com`) and custom SAML
  apps both work. Differences from Okta and Entra: Google's OIDC sends no
  groups, so map roles with SAML (add "Group membership" to the custom app's
  attribute mapping, named `groups`) or use invites and Join automatically;
  and Google does not provision custom apps over SCIM, so leaving relies on
  Google refusing a suspended user's sign-in, plus an admin disabling or
  removing the account in Employees.
- **Checked against the real providers.** `WEEHS_LIVE_IDP=1 npx vitest run
src/shared/data/realProviders.test.js` reads Google's and Microsoft's live
  discovery documents through the same code, and sends Google a real sign-in
  request (refused only for its made-up client). A person signing in still
  needs a real account in a real tenant: do that once with each customer's
  provider before going live.
- **SAML email.** Read from an attribute named `email`, `mail` or
  `emailAddress`, or the standard claim
  `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`
  (Microsoft Entra, AD FS), and only then from NameID. Entra's NameID is the
  user principal name, which is not always the address people were invited
  with.
- **One server process.** Sign-in round trips are held in the process's
  memory, so run one `app` container, not several behind a load balancer.
- **Server jobs not carried over from the hosted product.** Notification
  mail for incidents, permits and drills, the weather digest, the WhatsApp
  bot, Metabase analytics and the personal-data (subject access) export ran as
  hosted functions and are not part of this server. The screens that use them
  report the job as unavailable. Invitation mail works when SMTP is set.

## Testing locally

The policy tests can run against a real Postgres as well as the embedded one:

```bash
OHSMS_TEST_PG_URL=postgres://ehs_app:PASS@127.0.0.1:5432/ehs OHSMS_TEST_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/ehs npx vitest run src/shared/data/adapters/postgres.rls.test.js
```

`src/shared/data/controlPlane.test.js` runs the whole deployed path — /setup,
restart, SAML sign-in, invites, SCIM, member reads — on an embedded database
set up the way a managed one is (an ordinary app role, the two roles made by
an administrator), so CI catches what only appears without superuser.
