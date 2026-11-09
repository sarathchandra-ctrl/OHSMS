# Observability

What watches the deployed app, and where a failure goes. Kept short so it
cannot drift from the two mechanisms that actually exist.

---

## Errors (the app is up and throwing)

**Sentry**, when the hosting build was given `VITE_SENTRY_DSN`. Wired in
`src/shared/monitoring.js`. CSP allows the ingest hosts in `firebase.json`.
Public QR/permit/LOTO paths are sanitised so a scan token does not leave the
origin.

If the DSN is unset, crashes stay in the browser console. Maintenance →
"Send a test event" proves the deployed build can actually reach Sentry.

Alert path: whatever the Sentry project is configured to send (email / Slack
/ nothing). This repository does not own that console.

## Downtime (the app is not up)

**GitHub Actions** workflow `.github/workflows/uptime.yml`:

- Every 15 minutes, and on `workflow_dispatch`.
- `GET {origin}/health.json` and require `"status":"ok"`.
- Production URL: repository variable `PRODUCTION_HOSTING_URL`, falling back
  to the public site already named in the root `SECURITY.md`
  (`https://suite.weehs.org`).
- Staging URL: repository variable `STAGING_HOSTING_URL`. If unset, the
  staging job is skipped — this public tree does not guess a staging
  hostname.

`public/health.json` is a static file copied into the hosting `dist`. Firebase
Hosting serves existing files ahead of the SPA rewrite, so a down Functions
tier or a down Firestore still leaves this check green if Hosting itself is
up. That is the point: it is an **uptime** check for the URL a user types,
not a deep probe of every backend. Sentry covers the "hosting is up and the
app is crashing" half.

### Alert path

A failed run emails the GitHub user(s) who have Actions failure emails
enabled on this repository (GitHub → Settings → Notifications → Actions).
There is no new paid SaaS. Watch the `Uptime` workflow on the Actions tab;
pin it if this is the first time anyone will look.

A red uptime check is "Hosting did not serve `/health.json` in time", not
"Firestore is empty" and not "Sentry is down".

## What is still not here

Metrics, SLOs, on-call rotations, Cloud Monitoring dashboards. The Recycle
Bin sweep already fails its Cloud Functions invocation when it had errors
(`stack/lib/retention.js` `summarizeFailures`); that alert lives in the
private production runbook (§2a), not in this file.
