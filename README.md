# OHS MS — Occupational Health & Safety Management System

One organization's OHS platform: seventeen health-&-safety domains in one app
with a single sign-on, one dashboard and one audit trail — installed on **the
organization's own Cloudflare account** — the app, its server and its
Cloudflare D1 (SQLite) database.

Built with **Vite + React + Tailwind CSS**, and a Node 22 server (`stack/`)
over **SQLite** (Cloudflare D1), with every access rule enforced in
`stack/policy.mjs`. Deploying: [`DEPLOYMENT.md`](DEPLOYMENT.md). UI is an **amber+white glass** ops dashboard (amber canvas,
frosted white panels, logo teal / amber / siren) with **Emil Kowalski**-style
motion and **skeleton loaders** throughout.

## Modules

`src/shared/modules/registry.js` is the single source of truth: it drives the
sidebar, the dashboard grid and route mounting in `App.jsx`. If this table and
that file disagree, the file is right.

| Module                                  | Key           | Directory      | What it does                                                                        |
| --------------------------------------- | ------------- | -------------- | ----------------------------------------------------------------------------------- |
| Incidents & Investigation               | `incidents`   | `incidents/`   | Report incidents & near-misses, run 5-Why / Fishbone investigations, track CAPA     |
| Hazard Identification & Risk Assessment | `hira`        | `hira/`        | Hazard register with a likelihood × severity risk matrix and controls               |
| Inspections                             | `inspections` | `inspections/` | Scheduled inspections and checklist walkthroughs with findings                      |
| Internal Audit                          | `audit`       | `audit/`       | ISO 45001 audit plans, findings and corrective actions                              |
| Permit to Work                          | `ptw`         | `ptw/`         | Raise, approve and close work permits with QR verification                          |
| Lockout / Tagout                        | `loto`        | `loto/`        | Hazardous energy control procedures and lock/tag records                            |
| Emergency Equipment Inventory           | `equipment`   | `fire/`        | Extinguishers, AEDs, fire-alarm systems and signages with full inspection lifecycle |
| Mock Drills                             | `drills`      | `fire/`        | Fire drills and emergency scenarios with scored checklist reports                   |
| HSE Committee Meetings                  | `committee`   | `committee/`   | Schedule meetings, capture minutes, track actions                                   |
| Training & Certifications               | `training`    | `training/`    | Courses, certifications and expiry alerts                                           |
| Document Library & SDS                  | `documents`   | `documents/`   | Versioned policies, SOPs, forms and Safety Data Sheets                              |
| Emergency Response (FERP)               | `emergency`   | `emergency/`   | FERP contacts, evacuation plans, scenario rescue plans                              |
| Objectives & Targets                    | `objectives`  | `objectives/`  | OH&S KPI scorecard against target at org, region and site level                     |
| Site Weather Risk                       | `weather`     | `weather/`     | Conditions at every site read as occupational risk — heat stress, wind, lightning   |
| CCTV Inventory & Health                 | `cctv`        | `cctv/`        | Cameras, DVRs and network devices as one chain, so a dead switch reads as one fault |
| Customer Escalations & Legal            | `stakeholder` | `stakeholder/` | Escalations and the legal matters they turn into                                    |
| Central Action Tracker                  | `actions`     | `actions/`     | Every CAPA and action item across all modules, updated in place                     |

The weather-risk digest takes each site’s precautions from its **site type**.
Adding a site — the form, or a CSV import, including a sheet saved from
Excel — asks for one. The list offered to every organisation is Office,
Indoor gym, Indoor pool, Indoor court, Warehouse, Kitchen/Cafeteria, Retail
store, Outdoor site/Construction, Manufacturing/Plant and Other, plus any
activity that organisation has configured under Org Settings. A custom
activity can carry its own heat, rain and adverse-weather sentences on that
same screen. A site that already exists may still have no type: the mail
then uses the organisation’s activities, and the general paragraph when
those are empty. Other does the same unless an admin has written a sentence
for it. An admin can also map an entity name to a site type and fill that
type on the sites that still have none. The match ignores case, spaces and
punctuation in the whole entity name. The list is per organisation; a
supplied default covers the ownership names FOFO, FOCO, COCO, Marketplace,
EBO and D2C. The same list is edited from Sites: the register has a Site
type column, each site’s edit form sets its own, and selecting several
sites sets one type on all of them. The entity mapping sits on that page
for an admin as well as under Org Settings. A manager can edit site types;
saving the mapping is an organisation setting, so it stays with the admin.

Two registry keys — `equipment` and `drills` — are both served by
`src/modules/fire/`. That is the one place the registry and the filesystem do
not share a name.

## Architecture

One installation serves one organization. Three deployable pieces:

- **Web app** (`src/`) — one Vite React SPA. A shared shell (auth, nav,
  dashboard) mounts each module as a lazily-loaded feature area under
  `src/modules/<key>/`. Public routes exist for the QR flows (`/qr/:token`,
  `/permit/:token`, `/p/:id`, `/t/:id/:point`).
- **Server** (`stack/`) — its own npm package. Email-and-password sign-in
  (passwords kept only as PBKDF2 hashes), the data gateway, server jobs
  (`/rpc/*`) and file storage. It creates the organization and its first
  administrator on first start.
- **Cloudflare Worker** (`worker/`) — serves the built app from the edge and
  runs the server on Cloudflare (database in D1, files in R2), or
  forwards to a self-hosted server through a Cloudflare Tunnel.

Cross-cutting:

- **Data** — SQLite (Cloudflare D1, or a file in Docker), one `documents`
  table addressed by collection path (`incidents`, `permits/<id>/events`, …).
  Access is enforced in `stack/policy.mjs`, checked by `stack/engine.mjs`
  before every read and write. Only the server's own jobs skip the rules.
- **Roles** — `admin`, `manager`, `member`, `auditor`
  (`src/shared/auth/permissions.js`) plus site scoping. An administrator adds
  people with a temporary password and can reset passwords.
- **Files** — stored on the server's disk (`/blob`), reached through signed
  URLs the server issues after re-reading the caller's live profile.
- **Application-layer encryption** (`src/shared/crypto/`) — envelope
  encryption over the fields named in `policy.js`, keys wrapped by the
  server's `DATA_KEY_MASTER`. Gated by `VITE_ENCRYPTION`.
- **Modules on/off** — one setting, `moduleEntitlements/organization`,
  writable by an administrator.

```
src/
  shared/       auth · org · audit · crypto · data · storage · ui kit
                layout · module-kit · docId · modules registry
  pages/        auth/ · admin/ · analytics/ · portal/ · Dashboard
  modules/      incidents hira inspections audit ptw loto fire committee training
                documents emergency objectives weather cctv stakeholder actions
stack/          the organization's server (own package); stack/lib shared rules
worker/         Cloudflare Worker
selfhost/       Docker Compose install for the server
docs/           deployment, security register, compliance
```

## Getting started (local)

Needs Node 22.

```bash
npm ci
```

```bash
npm ci --prefix stack
```

Start the app and its local backend together:

```bash
npm run dev:local
```

Open `http://127.0.0.1:5173`. The initial administrator login is saved in
`stack/data/local/credentials.json` (ignored by Git). SQLite, attachments,
and a local password-reset email outbox are stored in that same local folder.
Cloudflare credentials are not required. See [local development](docs/LOCAL-DEVELOPMENT.md).

## Scripts

| Script                            | Purpose                                         |
| --------------------------------- | ----------------------------------------------- |
| `npm run dev`                     | Vite dev server                                 |
| `npm run dev:local`               | App, local SQLite backend, uploads and email outbox |
| `npm run build`                   | Production build of the app (`dist/`)           |
| `npm run server`                  | The organization's server (`stack/main.mjs`)    |
| `npm run deploy:cloudflare`       | Build and deploy the Cloudflare Worker          |
| `npm test`                        | Unit tests: app, server and Worker (Vitest)     |
| `npm run lint` / `npm run format` | Lint / format                                   |

## Testing

- **Unit** — colocated `*.test.js(x)` beside the source, weighted towards pure
  logic: risk matrices, RBAC, crypto, the data/storage adapters, CSV and PDF
  export, scheduling, energy sources. They run in parallel and are stable there;
  DOM tests carry a `// @vitest-environment jsdom` docblock and the default is
  `node`.
- **Access rules** — `src/shared/data/adapters/postgres.rls.test.js`
  runs `stack/policy.mjs` through the engine on SQLite and asserts that signed-out,
  pending and disabled accounts see nothing, role-gated writes, medical-record
  confinement, the server-only directory paths and the limits of the anonymous
  QR write surfaces. These send hostile payloads, not well-behaved ones.
- **Server** — `src/shared/data/server.test.js` drives the real server:
  first start, password sign-in and lockout, the forced password change,
  adding people and resets, on a database set up like a hosted one.
- **Accessibility** — `e2e/accessibility.spec.js` runs axe against the rendered
  DOM and fails on any serious or critical WCAG 2.1 AA violation. It is the half
  of the gate `eslint-plugin-jsx-a11y` cannot be: this app binds most labels to
  their controls at runtime, which a static rule cannot see.
- **Capped reads** — `e2e/capped-reads.spec.js`, run with `VITE_TEST_READ_CAP`
  set low, asserts that screens totalling a capped collection actually render
  the "these figures are incomplete" notice (portal home is the exception: it
  must not).
- **End-to-end** — `e2e/` under Playwright. The older specs were written
  against the Firebase emulators and need a seeded server to run.
