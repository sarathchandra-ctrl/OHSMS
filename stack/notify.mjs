// Delivers what stack/lib/notify.js decides on: an item in each person's
// in-app inbox (the bell, inbox/<uid>/items) and, when a mailer is
// configured, an email. That file holds the rules (who, what, and what is
// never sent); this one loads what they read and delivers.
//
// Two entry points:
//   notifyChanges  after a commit, in the background, so the save that caused
//                  a mail never waits for it or fails because of it;
//   sendDigests    once a day from the digest cron (stack/schedule.mjs).
//
// Both read as the server (WORKER): a mail goes to someone other than the
// writer, and the writer's own session cannot see, say, the managers of a
// site they report at.

import { digestFor, eventMessages, notifySettings } from './lib/notify.js'

const WORKER = { role: 'ohsms_worker', uid: '' }

// Paths whose changes can call for a mail. Anything else returns before a
// single read: most commits (a checklist tick, a profile save) mail no one.
const EVENT_PATHS = new Set(['incidents', 'permits', 'auditFindings', 'trainingAssignments'])

// One commit cannot become a mail storm. The largest honest case is a
// training session assigned to a whole site, and even that is one mail each;
// past this, the rest are dropped and counted.
export const MAX_EVENT_MAILS = 100

// A day's digest is sent once per person even if the cron fires twice (a
// retry, or an administrator's "send now" after the morning run).
const DIGEST_TTL_S = 36 * 3600

async function directory(engine) {
  const [users, sites, org] = await Promise.all([
    engine.list(WORKER, 'users', {}),
    engine.list(WORKER, 'sites', {}),
    engine.get(WORKER, 'organization', 'profile'),
  ])
  return { users, sites, org: org || {} }
}

async function deliver(mail, messages, limit) {
  let sent = 0
  let failed = 0
  for (const m of messages.slice(0, limit)) {
    const r = await mail({ to: m.to, subject: m.subject, text: m.text }).catch(() => ({ sent: false }))
    if (r?.sent) sent += 1
    else failed += 1
  }
  return { sent, failed, dropped: Math.max(0, messages.length - limit) }
}

// An inbox item is the message without the mail's body: a title, one line,
// the in-app link. Same rules, so the bell never says more than the mail.
const inboxOps = (messages, now) =>
  messages
    .filter((m) => m.uid)
    .map((m) => ({
      type: 'set',
      path: `inbox/${m.uid}/items`,
      id: crypto.randomUUID(),
      merge: false,
      data: {
        kind: m.kind,
        title: m.subject,
        summary: m.summary,
        link: m.path,
        createdAt: new Date(now).toISOString(),
        readAt: null,
      },
    }))

/** The bell items and mail one commit's changes call for. Never throws. */
export async function notifyChanges(engine, { changes = [], actorUid = '', mail = null, origin = '', now = Date.now() }) {
  const none = { belled: 0, sent: 0, failed: 0, dropped: 0 }
  if (!changes.some((c) => EVENT_PATHS.has(c.path))) return none
  try {
    const { users, sites, org } = await directory(engine)
    const messages = eventMessages(changes, { users, sites, org, origin, actorUid })
    const ops = inboxOps(messages, now).slice(0, MAX_EVENT_MAILS)
    if (ops.length) await engine.commit(WORKER, ops)
    const mailed = mail ? await deliver(mail, messages, MAX_EVENT_MAILS) : { sent: 0, failed: 0, dropped: 0 }
    return { belled: ops.length, ...mailed }
  } catch (err) {
    console.error('notification failed', err?.message || err)
    return { ...none, error: err?.message || String(err) }
  }
}

/** Today's date in India, where the digest is read at 08:00. */
export function digestDay(now = Date.now()) {
  return new Date(now + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
}

async function claimDigest(db, key, now) {
  // Taken only if absent or expired: a second run the same day finds the
  // claim and leaves the row alone, so RETURNING gives it nothing.
  const row = await db
    .prepare(
      `INSERT INTO auth_pending (key, value, expires_at) VALUES (?, '1', ?)
       ON CONFLICT (key) DO UPDATE SET value = '1', expires_at = excluded.expires_at
       WHERE auth_pending.expires_at <= ?
       RETURNING key`
    )
    .bind(key, now + DIGEST_TTL_S * 1000, now)
    .first()
  return Boolean(row)
}

const releaseDigest = (db, key) => db.prepare('DELETE FROM auth_pending WHERE key = ?').bind(key).run()

/** Each person's daily summary, at most once a day each. */
export async function sendDigests(engine, db, { mail, origin = '', now = Date.now() } = {}) {
  if (!mail) return { skipped: 'no-mail' }
  const { users, sites, org } = await directory(engine)
  if (!notifySettings(org).digest) return { skipped: 'off' }
  const read = (path) => engine.list(WORKER, path, {})
  const [incidents, trainingAssignments, trainingRecords, auditFindings, extinguishers, permits, documents] =
    await Promise.all([
      read('incidents'),
      read('trainingAssignments'),
      read('trainingRecords'),
      read('auditFindings'),
      read('extinguishers'),
      read('permits'),
      read('documents'),
    ])
  const data = { incidents, trainingAssignments, trainingRecords, auditFindings, extinguishers, permits, documents, sites }
  const today = digestDay(now)
  const out = { sent: 0, failed: 0, already: 0, nothing: 0 }
  for (const user of users) {
    const msg = digestFor(user, data, { today, origin })
    if (!msg) {
      out.nothing += 1
      continue
    }
    const key = `digest:${user.id}:${today}`
    if (!(await claimDigest(db, key, now))) {
      out.already += 1
      continue
    }
    const r = await mail({ to: msg.to, subject: msg.subject, text: msg.text }).catch(() => ({ sent: false }))
    if (r?.sent) out.sent += 1
    else {
      out.failed += 1
      // Not sent: a later run today (or "send now") may try again.
      await releaseDigest(db, key)
    }
  }
  return out
}
