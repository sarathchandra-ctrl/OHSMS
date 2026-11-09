# Running OHSMS locally

Use Node 22.13 or newer (Node 22 LTS is recommended). From the repository root:

```bash
npm ci
npm ci --prefix stack
npm run dev:local
```

Open `http://127.0.0.1:5173`. Open `stack/data/local/credentials.json` to
find the generated administrator email and initial password. The account
is created only when the local database has no administrator. An existing
password is never reset on restart.

The command starts Vite and the real application backend together. Vite proxies
API requests to that backend, so runtime settings, sign-in, data and uploads
all use the same browser origin. Both servers listen only on loopback.

Cloudflare, Docker, PostgreSQL and production credentials are not needed:

| Local component | Location |
| --- | --- |
| SQLite database | `stack/data/local/ohsms.sqlite` |
| Uploaded attachments, up to 2 MB each | `stack/data/local/files/` |
| Generated development credentials and encryption keys | `stack/data/local/credentials.json` |
| Simulated emails, including password-reset links | `stack/data/local/mailbox.ndjson` |

These files are ignored by Git. Credentials are generated once and kept in
a private file. Local email is written to the outbox; it is not sent to anyone.
To test Forgot password, submit the local account's email, then open the reset
link in the newest outbox entry. That flow also works after changing the
initial password, when the original credentials file no longer has the current one.

Keep the local state folder together so the database and its encryption keys
remain paired. This local database is separate from Cloudflare D1.

For another port, set `OHSMS_LOCAL_PORT`. To choose a separate local state folder,
set `OHSMS_LOCAL_DATA_DIR` to an absolute path. Stop both servers with Ctrl+C.

`npm run dev` remains available when you want only the frontend and already
have a configured backend. `npm run server` remains the production server
entry point with the settings documented in `docs/SELF-HOSTING.md`.
