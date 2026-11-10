// Delivers what stack/lib/notify.js decides on: an item in each person's
// in-app inbox (the bell, inbox/<uid>/items) and, when a mailer is
// configured, an email. That file holds the rules (who, what, and what is
// never sent); this one loads what they read and delivers.
//
// Entry points:
//   notifyChanges     after a commit, in the background, so the save that
//                     caused it never waits for it or fails because of it;
//   runSixHourly      RCA due and weather risk (from the 5-minute cron, once
//                     per 6-hour slot; stack/schedule.mjs);
//   runDailyNotices   equipment due, yearly reviews, the monthly uptime
//                     report (with the 08:00 digest cron);
//   sendDigests       each person's daily summary email (same cron).
//
// Both read as the server (WORKER): a mail goes to someone other than the
// writer, and the writer's own session cannot see, say, the managers of a
// site they report at.

import { digestFor, eventMessages, notifySettings, reportAsset } from './lib/notify.js'
import {
  equipmentDueItems,
  equipmentDueMessages,
  rcaMessages,
  reviewDueItems,
  reviewMessages,
  uptimeMessages,
  weatherMessages,
} from './lib/notifySchedule.js'
import { gridKey, requestPoint } from './lib/openMeteo.js'
import { weatherBucket } from './lib/siteWeather.js'
import { weatherCacheStore } from './workers.mjs'

const WORKER = { role: 'ohsms_worker', uid: '' }

// Paths whose changes can call for a mail. Anything else returns before a
// single read: most commits (a checklist tick, a profile save) mail no one.
const EVENT_PATHS = new Set([
  'incidents',
  'permits',
  'auditFindings',
  'trainingAssignments',
  'assessments',
  'reports',
  'mockDrills',
  'consultations',
])

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

// A claim in auth_pending (which the data API never reads): taken only if
// absent or expired, so a second run finds it and RETURNING gives nothing.
// This is what makes every scheduled notice, and the throttle on edits, a
// one-time thing however often the clock fires.
async function claim(db, key, now, ttlS) {
  const row = await db
    .prepare(
      `INSERT INTO auth_pending (key, value, expires_at) VALUES (?, '1', ?)
       ON CONFLICT (key) DO UPDATE SET value = '1', expires_at = excluded.expires_at
       WHERE auth_pending.expires_at <= ?
       RETURNING key`
    )
    .bind(key, now + ttlS * 1000, now)
    .first()
  return Boolean(row)
}

const release = (db, key) => db.prepare('DELETE FROM auth_pending WHERE key = ?').bind(key).run()

/** Bell items for every message with a uid, then the mail. */
async function deliverAll(engine, messages, { mail, now, limit = MAX_EVENT_MAILS }) {
  const ops = inboxOps(messages, now).slice(0, limit)
  if (ops.length) await engine.commit(WORKER, ops)
  const mailed = mail ? await deliver(mail, messages, limit) : { sent: 0, failed: 0, dropped: 0 }
  return { belled: ops.length, ...mailed }
}

// Edits to one record notify once an hour (a risk assessment is saved many
// times while it is written).
const THROTTLE_S = 3600

/** The bell items and mail one commit's changes call for. Never throws. */
export async function notifyChanges(engine, { changes = [], actorUid = '', mail = null, origin = '', now = Date.now() }) {
  const none = { belled: 0, sent: 0, failed: 0, dropped: 0 }
  if (!changes.some((c) => EVENT_PATHS.has(c.path))) return none
  try {
    const { users, sites, org } = await directory(engine)
    // A defect report names its unit, not its site: read the unit.
    const assets = {}
    for (const c of changes) {
      const target = c.path === 'reports' && !c.before ? reportAsset(c.after) : null
      if (target) assets[target.join('/')] = await engine.get(WORKER, target[0], target[1])
    }
    const all = eventMessages(changes, { users, sites, org, origin, actorUid, assets })
    const messages = []
    for (const m of all) {
      if (!m.throttle || (await claim(engine.db, `throttle:${m.throttle}`, now, THROTTLE_S))) messages.push(m)
    }
    return await deliverAll(engine, messages, { mail, now })
  } catch (err) {
    console.error('notification failed', err?.message || err)
    return { ...none, error: err?.message || String(err) }
  }
}

// ── On the clock ─────────────────────────────────────────────────────────────

// Larger than one commit's cap: a run tells each person once, but an
// organization can have hundreds of people.
const MAX_SCHEDULED = 2000
const SLOT_TTL_S = 7 * 3600
const ITEM_TTL_S = 400 * 24 * 3600

/**
 * Every 6 hours (run from the 5-minute cron, once per 6-hour IST slot): RCA
 * still due, and weather risk. A failed step is reported, not fatal.
 */
export async function runSixHourly(engine, db, { mail = null, origin = '', now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const slot = weatherBucket(new Date(now))
  if (!slot || !(await claim(db, `slot6:${slot}`, now, SLOT_TTL_S))) return { skipped: 'slot-done', slot }
  const { users, sites, org } = await directory(engine)
  const on = notifySettings(org)
  const out = { slot }
  if (on.rca) {
    try {
      const incidents = await engine.list(WORKER, 'incidents', {})
      out.rca = await deliverAll(engine, rcaMessages({ incidents, users, sites, origin }), { mail, now, limit: MAX_SCHEDULED })
    } catch (err) {
      out.rca = { error: err?.message || String(err) }
    }
  }
  if (on.weather) {
    try {
      // One reading per site with coordinates, through the same cache the
      // Weather pages use, so a slot already fetched costs nothing.
      const cache = weatherCacheStore(engine)
      const observations = {}
      for (const site of sites) {
        const key = gridKey(Number(site.lat), Number(site.lng))
        if (!key) continue
        const [lat, lng] = key.split(',').map(Number)
        const r = await requestPoint({ key, lat, lng }, { cache, slot, fetchImpl, now })
        if (r?.obs) observations[site.id] = r.obs
      }
      out.weather = await deliverAll(engine, weatherMessages({ observations, users, sites, origin }), { mail, now, limit: MAX_SCHEDULED })
    } catch (err) {
      out.weather = { error: err?.message || String(err) }
    }
  }
  return out
}

/** Items not told before, each claimed as it is taken. */
async function fresh(db, items, now) {
  const out = []
  for (const it of items) if (await claim(db, it.claim, now, ITEM_TTL_S)) out.push(it)
  return out
}

/**
 * Daily, with the 08:00 summary: equipment due, yearly reviews, and on the
 * 1st of the month the uptime report.
 */
export async function runDailyNotices(engine, db, { mail = null, origin = '', now = Date.now() } = {}) {
  const { users, sites, org } = await directory(engine)
  const on = notifySettings(org)
  const today = digestDay(now)
  const read = (path) => engine.list(WORKER, path, {})
  const ctx = { users, sites, origin }
  const out = { today }
  const step = async (name, fn) => {
    try {
      out[name] = await fn()
    } catch (err) {
      out[name] = { error: err?.message || String(err) }
    }
  }
  if (on.equipmentDue) {
    await step('equipmentDue', async () => {
      const items = await fresh(db, equipmentDueItems({ extinguishers: await read('extinguishers'), aeds: await read('aeds'), today }), now)
      return deliverAll(engine, equipmentDueMessages(items, ctx), { mail, now, limit: MAX_SCHEDULED })
    })
  }
  if (on.hiraReview) {
    await step('hiraReview', async () => {
      const items = await fresh(db, reviewDueItems({ assessments: await read('assessments'), today }), now)
      return deliverAll(engine, reviewMessages(items, ctx), { mail, now, limit: MAX_SCHEDULED })
    })
  }
  const month = today.slice(0, 7)
  if (on.uptime && today.endsWith('-01') && (await claim(db, `uptime:${month}`, now, 40 * 24 * 3600))) {
    await step('uptime', async () => {
      const [extinguishers, aeds, fas, signages] = await Promise.all(['extinguishers', 'aeds', 'fas', 'signages'].map(read))
      const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      return deliverAll(engine, uptimeMessages({ extinguishers, aeds, fas, signages }, { ...ctx, month: label }), { mail, now, limit: MAX_SCHEDULED })
    })
  }
  return out
}

/** Today's date in India, where the digest is read at 08:00. */
export function digestDay(now = Date.now()) {
  return new Date(now + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
}

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
    if (!(await claim(db, key, now, DIGEST_TTL_S))) {
      out.already += 1
      continue
    }
    const r = await mail({ to: msg.to, subject: msg.subject, text: msg.text }).catch(() => ({ sent: false }))
    if (r?.sent) out.sent += 1
    else {
      out.failed += 1
      // Not sent: a later run today (or "send now") may try again.
      await release(db, key)
    }
  }
  return out
}
