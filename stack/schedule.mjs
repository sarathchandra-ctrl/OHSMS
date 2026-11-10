// The server's own jobs, on a clock.
//
// On Firebase these were scheduled functions. The current server had the jobs
// (stack/workers.mjs) but nothing ran them, and nothing in the app called
// them either: the Recycle Bin purge, the LOTO due/overdue flags and the
// withdrawal of stale public permit pages simply never happened. Now:
//
//   every 5 minutes   LOTO due / overdue flags (sweepLoto)
//   nightly, 03:45 IST (22:15 UTC)
//                     the Recycle Bin purge (runRetention), closed LOTO
//                     permits a year on (purgeClosedLotoPermits), and stale
//                     public permit pages withdrawn (withdrawStaleMirrors)
//
// They run from the cron triggers in wrangler.jsonc (worker/index.js
// `scheduled`).
//
// Each nightly job runs even if an earlier one failed, and the run then
// throws, naming every failure: an unattended deletion job that fails quietly
// looks exactly like one with nothing to do.

import { purgeClosedLotoPermits, runRetention, sweepLoto, withdrawStaleMirrors } from './workers.mjs'

export const FREQUENT_CRON = '*/5 * * * *'
export const NIGHTLY_CRON = '15 22 * * *'

export async function runFrequent(engine, { now = Date.now() } = {}) {
  return { lotoSweep: await sweepLoto(engine, { nowMs: now }) }
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
  return ''
}
