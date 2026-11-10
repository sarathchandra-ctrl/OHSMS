# Self-hosting Cult Fit SMS on your own server

This runs Cult Fit SMS for one organization on a computer or server with
Docker: a virtual machine on any cloud, or a server in your own building.
Your records and uploaded files stay on that server, in one SQLite
database file and a files folder. People sign in with an email and password kept by the server; an
administrator adds them. One installation is one organization.

Everything is in [`selfhost/`](../selfhost): `install.sh` (sets it all up in
one command), `compose.yaml` (the app and an HTTPS front door),
`.env.example` (every setting).

Two front doors, chosen by `COMPOSE_PROFILES` in `.env`:

- `caddy` (this page): HTTPS on the server itself, ports 80 and 443 open.
- `cloudflare`: Cloudflare in front, through a Cloudflare Tunnel, with no
  inbound ports. Follow [`CLOUDFLARE.md`](CLOUDFLARE.md).

## What you need

- A Linux server with **Docker** and the **Docker Compose plugin**. 2 vCPU,
  4 GB RAM and 40 GB disk are comfortable for a few hundred users.
- A **domain name** for it, for example `ehs.example.com`, with a DNS `A`
  record pointing at the server's public IP address.
- **Ports 80 and 443** open to the internet. Port 80 is needed for the free
  certificate; everything is served over 443.
- The **email address of the first administrator**.
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
./install.sh --domain ehs.example.com --image ghcr.io/OWNER/ohsms-server@sha256:DIGEST --admin-email you@example.com
```

It checks that Docker, Compose, `openssl` and `curl` are there, writes `.env`
with every secret freshly generated (readable by you only), starts the
database, the app and Caddy, waits until `https://ehs.example.com/health`
answers, and prints the status. The first start creates the database, the
two roles its security rules use, and an ordinary account for the app
(`init-db.sh`). Caddy obtains the HTTPS certificate, which can take a minute.

**Back up `.env` somewhere safe and separate from the server.** Without
`DATA_KEY_MASTER` encrypted fields cannot be opened and two-step login
stops accepting codes until an admin resets it for each person; without the database
passwords the data cannot be reached. `.env` also holds `ADMIN_PASSWORD`, the
first administrator's one-time password.

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
- `DATA_KEY_MASTER`: `openssl rand -base64 32`.
- `SESSION_SECRET`: `openssl rand -hex 32`.
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`: the first administrator (password at
  least 10 characters; it must be changed at first sign-in).
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

**Behind a proxy you run yourself.** The sign-in limits count wrong passwords
per visitor. Inside Docker, compose tells the server which front door is in
front (`FRONT_DOOR`, from `COMPOSE_PROFILES`), so it reads the visitor's
address from that proxy. If you run the server outside this compose file
behind your own proxy on the same machine or private network, set
`FRONT_DOOR=caddy` for any proxy that writes the visitor's address as the last
`X-Forwarded-For` entry. Without it every request appears to come from the
proxy, and one person guessing passwords can lock everyone out for 15
minutes (`stack/clientIp.mjs`).

## 4. Sign in

Open `https://ehs.example.com` and sign in with `ADMIN_EMAIL` and
`ADMIN_PASSWORD` from `.env`. The organization (`ORG_NAME`) and this first
administrator are created when the server first starts; you are asked to
choose your own password straight away. Then:

- **Employees → Add employee** gives each person a temporary password they
  change at first sign-in.
- **Employees → Reset password** handles a forgotten password: the server
  sends no mail, so an administrator sets a new temporary one and passes it
  on.
- **Sites**: add your locations.

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
Never change `DATA_KEY_MASTER` or `SESSION_SECRET` as part of an upgrade.

## Backups

Everything lives on the `data` volume: `ohsms.sqlite` (the database) and
`files/` (uploads). Take a consistent copy of the database while it runs:

```bash
docker compose exec app node -e "new (require('node:sqlite').DatabaseSync)('/srv/stack/data/ohsms.sqlite').exec(\"VACUUM INTO '/srv/stack/data/backup.sqlite'\")"
```

Then copy `backup.sqlite` and the `files/` folder off the server (for
example with `docker compose cp app:/srv/stack/data ./backup-$(date +%F)`),
together with `.env`. To restore, put them back on the volume before
starting the app.

Test a restore before you need one. A backup that has never been restored is
a hope, not a backup.

## Everyday operation

- **Logs:** `docker compose logs -f app`. The server runs its own scheduled
  jobs (`stack/schedule.mjs`): LOTO due/overdue flags every five minutes, and
  nightly at 03:45 IST (22:15 UTC) the Recycle Bin purge, the purge of LOTO
  permits closed more than a year ago, and the withdrawal of stale public permit
  pages. A run with a problem writes a `scheduled:` line to this log.
- **Stop:** `docker compose down` (data is kept). Never add `-v` unless you
  mean to delete the database.
- **Server updates:** keep the operating system and Docker patched; the
  database and app are not exposed to the internet, only Caddy is.
- **Disk:** watch free space; the database and its backups grow with use.

## Known limits

- **No mail-based password reset.** The server sends no password-reset mail;
  an administrator resets a forgotten password from Employees.
- **Server jobs not carried over from the hosted product.** Notification
  mail for incidents, permits and drills, the weather digest, the WhatsApp
  bot, Metabase analytics and the personal-data (subject access) export ran as
  hosted functions and are not part of this server. The screens that use them
  report the job as unavailable.

## Testing locally

`src/shared/data/adapters/postgres.rls.test.js` drives every access rule in
`stack/policy.mjs` through the real engine on an in-memory SQLite, with
hostile writes. `src/shared/data/server.test.js` runs the whole deployed path
— first start, password sign-in and lockout, the first-sign-in password
change, adding people, resets, member reads — through HTTP.
