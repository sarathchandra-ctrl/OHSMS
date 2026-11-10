// Entry point for the organization's server (Docker, or any host that runs
// Node 22). Reads the environment, refuses to start with a setting missing or
// weak, and serves. docs/SELF-HOSTING.md lists every variable.

import nodemailer from 'nodemailer'
import { createDedicatedApp } from './app.mjs'
import { openSqlite } from './sqlite.mjs'

const env = process.env
const problems = []

function required(name, { min = 1 } = {}) {
  const value = String(env[name] || '').trim()
  if (value.length < min) {
    problems.push(min > 1 ? `${name} (at least ${min} characters)` : name)
  }
  return value
}

const origin = required('PUBLIC_ORIGIN').replace(/\/$/, '')
const sessionSecret = required('SESSION_SECRET', { min: 32 })
const dataKeyMaster = required('DATA_KEY_MASTER')

// Every file URL is built on this
// origin. Behind Cloudflare it is the Cloudflare hostname people type. Fail
// here, not on the first sign-in.
// Parsed, not pattern-matched: a pattern accepted `https://?x` and
// `https://user@host`, which are not origins and produce broken links.
if (origin) {
  let parsed = null
  try {
    parsed = new URL(origin)
  } catch {
    parsed = null
  }
  if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname || parsed.origin !== origin) {
    problems.push('PUBLIC_ORIGIN (an https:// origin with no path)')
  }
}

// The key-release worker refuses a master that is not exactly 32 bytes of
// base64, and it only finds out on the first sign-in that asks for a key. A
// hex secret passes a length check and decodes to 48 bytes.
if (dataKeyMaster) {
  const bytes = Buffer.from(dataKeyMaster.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (bytes.length !== 32) {
    problems.push('DATA_KEY_MASTER (32 random bytes, base64: openssl rand -base64 32)')
  }
}


if (problems.length) {
  process.stderr.write(
    `OHSMS server refused to start. Missing or invalid: ${problems.join(', ')}\n`
  )
  process.exit(1)
}

// Mail is optional and used only for password-reset links.
let mail = null
if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM) {
  const port = Number(env.SMTP_PORT || 587)
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    // 465 is TLS from the first byte; on any other port, refuse to send the
    // password over a connection that did not upgrade with STARTTLS.
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  })
  mail = async ({ to, subject, text }) => {
    try {
      await transport.sendMail({ from: env.MAIL_FROM, to, subject, text })
      return { sent: true }
    } catch (err) {
      process.stderr.write(`mail not sent: ${subject} (${err?.code || err?.message})\n`)
      return { sent: false }
    }
  }
}

// One SQLite file. Keep it on a volume and back it up with the files.
const db = openSqlite(env.DATABASE_FILE || new URL('./data/ohsms.sqlite', import.meta.url).pathname)
const { server } = await createDedicatedApp({
  db,
  origin,
  sessionSecret,
  dataKeyMaster,
  mail,
  staticDir: env.STATIC_DIR || new URL('./public', import.meta.url).pathname,
  blobDir: env.BLOB_DIR || new URL('./data/files', import.meta.url).pathname,
  // First start only: the organization and its first administrator, who must
  // change ADMIN_PASSWORD at first sign-in. Ignored once an admin exists.
  bootstrap: {
    orgName: env.ORG_NAME || 'Cult Fit',
    adminEmail: env.ADMIN_EMAIL || '',
    adminPassword: env.ADMIN_PASSWORD || '',
    mustChange: env.ADMIN_MUST_CHANGE !== 'false',
  },
})

const port = Number(env.PORT || 8080)
server.listen(port, '0.0.0.0', () => {
  process.stdout.write(
    `OHSMS server listening on ${port} for ${origin}${mail ? '' : ' (mail off)'}\n`
  )
})

// Docker sends SIGTERM before it stops the container.
process.on('SIGTERM', () => {
  server.close(() => {
    db.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 8000).unref()
})
