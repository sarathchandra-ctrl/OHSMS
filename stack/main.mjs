// Entry point for the organization's server (Docker, or any host that runs
// Node 22). Reads the environment, refuses to start with a setting missing or
// weak, and serves. docs/SELF-HOSTING.md lists every variable.

import nodemailer from 'nodemailer'
import { createDedicatedApp } from './app.mjs'
import { createPgDatabase } from './pg.mjs'
import { parseStateKey } from './state.mjs'

const env = process.env
const problems = []

function required(name, { min = 1 } = {}) {
  const value = String(env[name] || '').trim()
  if (value.length < min) {
    problems.push(min > 1 ? `${name} (at least ${min} characters)` : name)
  }
  return value
}

const databaseUrl = required('DATABASE_URL')
const origin = required('PUBLIC_ORIGIN').replace(/\/$/, '')
const controlToken = required('CONTROL_TOKEN', { min: 32 })
const sessionSecret = required('SESSION_SECRET', { min: 32 })
const dataKeyMaster = required('DATA_KEY_MASTER')
const stateKeyRaw = required('STATE_KEY')

// Every session redirect, SAML/OIDC callback and file URL is built on this
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

let stateKey
if (stateKeyRaw) {
  try {
    stateKey = parseStateKey(stateKeyRaw)
  } catch (err) {
    problems.push(err.message)
  }
}

if (problems.length) {
  process.stderr.write(
    `OHSMS server refused to start. Missing or invalid: ${problems.join(', ')}\n`
  )
  process.exit(1)
}

// Mail is optional. Without it invitations are not emailed; the administrator
// tells people to sign in.
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

const db = createPgDatabase(databaseUrl, { max: Number(env.DB_POOL_MAX || 5) })
const { server } = await createDedicatedApp({
  db,
  stateKey,
  origin,
  sessionSecret,
  controlToken,
  dataKeyMaster,
  mail,
  staticDir: env.STATIC_DIR || new URL('./public', import.meta.url).pathname,
  blobDir: env.BLOB_DIR || new URL('./data/files', import.meta.url).pathname,
  oidcAcceptUnverifiedEmail: env.OIDC_ACCEPT_UNVERIFIED_EMAIL === 'true',
})

const port = Number(env.PORT || 8080)
server.listen(port, '0.0.0.0', () => {
  process.stdout.write(
    `OHSMS server listening on ${port} for ${origin}${mail ? '' : ' (mail off)'}\n`
  )
})

// Docker sends SIGTERM before it stops the container.
process.on('SIGTERM', () => {
  server.close(() => db.end().finally(() => process.exit(0)))
  setTimeout(() => process.exit(0), 8000).unref()
})
