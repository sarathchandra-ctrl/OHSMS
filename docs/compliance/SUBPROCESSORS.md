# Subprocessor list

**DRAFT. Not legal advice.** Derived from what this application actually
imports, calls, or is configured to use — not from a marketing architecture
diagram. A service that is in `package.json` but never reached at runtime is
still listed if a production build can load it.

Last reviewed against the repository: 2026-11-05.

Counsel must confirm legal names, locations, and DPA links before this is
shown to a customer. **Do not add live project ids, function names, or
regions here** — this repository is public.

---

## Processors of tenant personal data

| Recipient | What it does here | Personal / health data? | How it is switched |
|---|---|---|---|
| **Google Cloud / Firebase** (Google LLC and affiliates) | Authentication (email, SAML/OIDC, TOTP), Cloud Firestore, Cloud Storage, Cloud Functions, Firebase Hosting, Secret Manager (escrowed encryption master key), App Check | Yes — the database, files, and functions tier *are* the product. Includes special-category health data when encryption is on (ciphertext at rest) and when it is off (plaintext). | Always on for a deployed tenant. |
| **Sentry** (Functional Software, Inc.) | Browser error reporting via `@sentry/browser`, loaded only when `VITE_SENTRY_DSN` is set. URLs on `/qr`, `/permit`, `/p` are sanitised so scan tokens do not leave the origin (`src/shared/monitoring.js`). | Possibly — stack traces, sanitised URLs, user-agent. **Must not** carry QR/permit tokens or medical field values; that is a product bug if it does. | Off unless the hosting build has a DSN. |
| **Brevo** (Sendinblue SAS) | Notification email from Cloud Functions (`stack/lib/mailer.js`, nodemailer) as `info@weehs.org` via `smtp-relay.brevo.com` port 587. The message contains the recipient's address, the organisation's display name, and the unsealed lines the template is allowed to carry. Sealed values are never included. | Yes — email address, name, and unsealed record text. | Off until `SMTP_USER` is the Brevo SMTP login and `SMTP_PASS` is the SMTP key. The From address defaults to `info@weehs.org`. |

No other paid error/uptime SaaS is in use. Hosting uptime is a GitHub Action
curling `/health.json` (`.github/workflows/uptime.yml`).

---

## Not subprocessors of tenant personal data (named so a reviewer does not guess)

These are reached from the **browser**, with data the user already sees, and
are not given a dump of the tenant:

| Recipient | What the browser sends | Notes |
|---|---|---|
| OpenStreetMap / Nominatim / Overpass (and listed failover hosts in `firebase.json` CSP) | Coordinates / map tiles | Same. |
| Google Fonts | Font files | No tenant records. |
| Google Identity / reCAPTCHA (App Check) | Attestation tokens on public write surfaces | Abuse control, not a copy of `/injuries`. |

Open-Meteo's forecast API (`api.open-meteo.com`) and air-quality API
(`air-quality-api.open-meteo.com`) are called from Cloud Functions only.
The call sends coordinates rounded to about a kilometre. It does not send
a site name, an organisation id, a health record, or an API key. The
browser does not call Open-Meteo.

A future malware-scanning vendor would **become** a subprocessor of medical
data if sealed or unsealed health documents were sent to it. That is
explicitly **not** done today. See `docs/ADR-0001-malware-scanning.md`.

---

## How to update this list

If the app starts talking to a new origin with tenant data (a new npm
runtime dependency that makes network calls, a new CSP `connect-src` host
that receives records, a new Cloud Function egress):

1. Add a row here in the same change.
2. Tell counsel — the DPA stub's subprocessor clause has to move with it.
3. Do not wait for the next enterprise questionnaire.
