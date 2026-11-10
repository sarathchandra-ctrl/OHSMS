# Subprocessor list

**DRAFT. Not legal advice.** Derived from what this application actually
imports, calls, or is configured to use — not from a marketing architecture
diagram. A service that is in `package.json` but never reached at runtime is
still listed if a production build can load it.

Last reviewed against the repository: 2026-11-10.

Counsel must confirm legal names, locations, and DPA links before this is
shown to a customer. **Do not add live account ids, hostnames, or regions
here** — this repository is public.

The application runs in one of two ways, and the list differs:

- **On Cloudflare** (`wrangler.jsonc`, `worker/`): the database, files, and
  server code run on Cloudflare.
- **Self-hosted** (`stack/`, `docs/SELF-HOSTING.md`): the organization's own
  server holds the database (SQLite) and files on its own disk. No hosting
  subprocessor is involved; mail goes to whichever SMTP provider the
  operator configures.

Firebase / Google Cloud is **no longer** used for authentication, the
database, files, functions or hosting. See "Legacy" below for the one
remaining link.

---

## Processors of tenant personal data

| Recipient | What it does here | Personal / health data? | How it is switched |
|---|---|---|---|
| **Cloudflare** (Cloudflare, Inc.) | Runs the server (Workers), the database (D1), uploaded files (R2), and holds the server secrets, including the encryption master key (Worker secrets). | Yes — the database and files *are* the product. Includes special-category health data: ciphertext at rest when encryption is on, plaintext when it is off. | Always on for a Cloudflare deployment. Not used when self-hosted. |
| **Resend** (Resend, Inc.) | Password-reset email from the Worker (`worker/mail.js`). The message carries the recipient's address and a one-time reset link. No record content. | Yes — email address. | Off unless `RESEND_API_KEY` and `MAIL_FROM` are set. Self-hosted servers use their own SMTP provider instead (`stack/main.mjs`), which is then the subprocessor. |
| **Sentry** (Functional Software, Inc.) | Browser error reporting via `@sentry/browser`, loaded only when `VITE_SENTRY_DSN` is set. URLs on `/qr`, `/permit`, `/p` are sanitised so scan tokens do not leave the origin (`src/shared/monitoring.js`). | Possibly — stack traces, sanitised URLs, user-agent. **Must not** carry QR/permit tokens or medical field values; that is a product bug if it does. | Off unless the build has a DSN. |

Password reset is the only email the application sends today; incident
notification email was removed on 2026-11-10.

No other paid error/uptime SaaS is in use. Hosting uptime is a GitHub Action
curling `/health.json` (`.github/workflows/uptime.yml`).

---

## Not subprocessors of tenant personal data (named so a reviewer does not guess)

These are reached from the **browser**, with data the user already sees, and
are not given a dump of the tenant. The allowed hosts are the
`Content-Security-Policy` in `public/_headers`.

| Recipient | What the browser sends | Notes |
|---|---|---|
| OpenStreetMap tiles, Nominatim, Overpass (and the failover mirrors in the CSP) | Map tile coordinates; a site's coordinates or address when looking up nearby services | No tenant records. |
| Google Places API | A site's coordinates, when finding nearby hospitals and fire stations | Only when the build sets `VITE_GOOGLE_MAPS_API_KEY`; otherwise the OpenStreetMap services above are used. |

Weather: the weather screens ask the organization's own server, which asks
Open-Meteo's public forecast and air-quality APIs (`stack/lib/openMeteo.js`).
What leaves is a coordinate rounded to about a kilometre: no site name, no
organization, no record, no API key. The browser does not call Open-Meteo.

## Legacy: Google Firebase Storage

Photos and documents attached before files moved off Firebase may still be
stored there, and records may still link to them. When such a record is
opened, the **browser** loads the file from Firebase Storage
(`firebasestorage.googleapis.com`, allowed in the CSP `img-src` for this
reason). Until those files are copied to the deployment's own storage,
Google remains a processor of those historical files.

A future malware-scanning vendor would **become** a subprocessor of medical
data if sealed or unsealed health documents were sent to it. That is
explicitly **not** done today. See `docs/ADR-0001-malware-scanning.md`.

---

## How to update this list

If the app starts talking to a new origin with tenant data (a new npm
runtime dependency that makes network calls, a new CSP `connect-src` host
that receives records, a new outbound call from the server):

1. Add a row here in the same change.
2. Tell counsel — the DPA stub's subprocessor clause has to move with it.
3. Do not wait for the next enterprise questionnaire.
