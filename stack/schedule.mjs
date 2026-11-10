// The server's own jobs, on a clock.
//
// On Firebase these were scheduled functions. The current server had the jobs
// (stack/workers.mjs) but nothing ran them, and nothing in the app called
// them either: the Recycle Bin purge and the withdrawal of stale public permit
// pages simply never happened. Now:
//
//   nightly, 03:45 IST (22:15 UTC)
//                     the Recycle Bin purge (runRetention), closed LOTO
//                     permits a year on (purgeClosedLotoPermits), and stale
//                     public permit pages withdrawn (withdrawStaleMirrors)
//   every 6 hours     (inside a 5-minute run, once per slot) RCA due and
//                     weather risk notifications. The 5-minute run also
//                     flagged LOTO permits due or overdue; the permits were
//                     removed from the app (2026-11-10), and that sweep with them.
//   daily, 08:00 IST (02:30 UTC)
//                     each person's summary email (when mail is configured),
//                     equipment due and yearly review notices, and on the
//                     1st the monthly uptime report (stack/notify.mjs)
//
// They run from the cron triggers in wrangler.jsonc (worker/index.js
// `scheduled`).
//
// Each nightly job runs even if an earlier one failed, and the run then
// throws, naming every failure: an unattended deletion job that fails quietly
// looks exactly like one with nothing to do.

import { purgeClosedLotoPermits, runRetention, withdrawStaleMirrors } from './workers.mjs'
import { runDailyNotices, runSixHourly, sendDigests } from './notify.mjs'

export const FREQUENT_CRON = '*/5 * * * *'
export const NIGHTLY_CRON = '15 22 * * *'
export const DIGEST_CRON = '30 2 * * *'

export async function runFrequent(engine, { now = Date.now(), notify = null } = {}) {
  const out = {}
  // The six-hourly notifications ride this cron rather than a cron of their
  // own (Cloudflare's free plan allows five triggers per account). The slot
  // claim in runSixHourly makes it once per 6-hour IST slot.
  if (notify) {
    try {
      out.sixHourly = await runSixHourly(engine, engine.db, { ...notify, now })
    } catch (err) {
      out.sixHourly = { error: err?.message || String(err) }
    }
  }
  return out
}

/** 08:00 IST: each person's summary email, and the daily and monthly notices. */
export async function runDaily(engine, { now = Date.now(), notify = {} } = {}) {
  const out = {}
  try {
    out.notices = await runDailyNotices(engine, engine.db, { ...notify, now })
  } catch (err) {
    out.notices = { error: err?.message || String(err) }
  }
  out.digest = notify.mail ? await sendDigests(engine, engine.db, { ...notify, now }) : { skipped: 'no-mail' }
  return out
}

export async function runNightly(engine, { blobStore = null, now = Date.now() } = {}) {
  const out = {}
  const problems = []
  const step = async (name, fn) => {
    try {
      out[name] = await fn()
      if (out[name]?.failure) problems.push(`${name}: ${out[name].failure.message}`)
    } catch (err) {
      out[name] = { error: err?.message || String(err) }
      problems.push(`${name}: ${out[name].error}`)
    }
  }
  await step('recycleBin', () => runRetention(engine, { now, blobStore }))
  await step('lotoPurge', () => purgeClosedLotoPermits(engine, { nowMs: now, blobStore }))
  await step('permitPages', () => withdrawStaleMirrors(engine, { now }))
  if (problems.length) {
    const err = new Error(`nightly jobs finished with failures: ${problems.join('; ')}`)
    err.results = out
    throw err
  }
  return out
}

/** Which job a cron expression names (Cloudflare passes event.cron). */
export function jobForCron(cron) {
  if (cron === FREQUENT_CRON) return 'frequent'
  if (cron === NIGHTLY_CRON) return 'nightly'
  if (cron === DIGEST_CRON) return 'digest'
  return ''
}
