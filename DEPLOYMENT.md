# Deployment

OHSMS runs for **one organization** on **that organization's own server and
Postgres database**. There is no shared or multi-tenant service.

| Front door                                                                | Guide                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------- |
| **Cloudflare** (Worker for the app + Tunnel to the server, no open ports) | [`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md)     |
| HTTPS directly on the server (Caddy, ports 80/443)                        | [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) |

Both use the same server image (`stack/Dockerfile`) and the same
`selfhost/compose.yaml`; `COMPOSE_PROFILES` in `selfhost/.env` picks the front
door.

## The pieces

- **`src/`** — the web app (React + Vite). Built to `dist/`.
- **`stack/`** — the organization's server (Node 22): sign-in through the
  organization's identity provider (OIDC, SAML or Supabase Auth), the data
  gateway (`/data`, enforced by Postgres row-level security in
  `stack/schema.sql`), server jobs (`/rpc/*`), file storage on disk
  (`/presign`, `/blob`), SCIM, and the one-time `/setup`.
- **`worker/`** — the Cloudflare Worker: serves `dist/` and forwards the
  server's paths through the Tunnel.
- **`selfhost/`** — compose file, `.env.example`, install script.

## First organization

There is exactly one. `/setup` creates it, once, and makes the email entered
there its first administrator. Everyone else is invited from **Employees**
(one by one, by email domain, by identity-provider group, or over SCIM).

## After each deploy

- `curl -s https://ehs.example.com/health` answers `{"ok":true}`.
- Sign in; open a few modules (Incidents, Inspections, Permits, LOTO,
  Training). Upload a photo and open it again.
- In DevTools, watch for `permission-denied` on `/data` — that is the
  database's row-level security refusing a read the screen expected.

## Rollback

- **Worker:** Cloudflare dashboard → the Worker → **Deployments** → roll back
  to the previous version (instant).
- **Server:** set `WEEHS_IMAGE` in `selfhost/.env` back to the previous image
  and `docker compose up -d`. Schema changes are additive; restore the
  database backup if a release says otherwise.

## Releases

Pushing a `v*` tag runs `.github/workflows/release.yml`: lint and tests, then
the server image to GitHub Container Registry and a `selfhost` archive on the
release page.
