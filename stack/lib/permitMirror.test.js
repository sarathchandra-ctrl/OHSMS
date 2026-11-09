import { describe, it, expect } from 'vitest'
import {
  STALE_AFTER_DAYS, MAX_WITHDRAWALS_PER_RUN, toMillis, effectiveEnd,
  shouldWithdraw, withdrawnFields, planWithdrawals,
} from './permitMirror.js'

const NOW = Date.parse('2026-08-16T00:00:00.000Z')
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()
const daysAhead = (n) => new Date(NOW + n * 24 * 60 * 60 * 1000).toISOString()

const live = (over = {}) => ({ token: 't1', validTo: daysAhead(1), withdrawn: false, ...over })

describe('reading whatever shape the end date arrived in', () => {
  it('handles ISO, epoch millis, Date and a Firestore Timestamp', () => {
    expect(toMillis(daysAgo(0))).toBe(NOW)
    expect(toMillis(NOW)).toBe(NOW)
    expect(toMillis(new Date(NOW))).toBe(NOW)
    expect(toMillis({ toMillis: () => 123 })).toBe(123)
    expect(toMillis({ seconds: 1, nanoseconds: 0 })).toBe(1000)
  })

  it('returns nothing for what it cannot read', () => {
    expect(toMillis(null)).toBeNull()
    expect(toMillis('not a date')).toBeNull()
    expect(toMillis({})).toBeNull()
  })
})

describe('the effective end of a permit', () => {
  it('is validTo when there is no extension', () => {
    expect(effectiveEnd({ validTo: daysAgo(3) })).toBe(Date.parse(daysAgo(3)))
  })

  // An extension only ever DELAYS withdrawal. Its approval state is not
  // consulted, because guessing wrong toward withdrawal removes a barrier check
  // from work that may still be running.
  it('takes the later of validTo and an extension, approved or not', () => {
    const m = { validTo: daysAgo(10), extension: { newValidTo: daysAgo(1) } }
    expect(effectiveEnd(m)).toBe(Date.parse(daysAgo(1)))
  })

  it('never lets an extension pull the end date earlier', () => {
    const m = { validTo: daysAgo(1), extension: { newValidTo: daysAgo(10) } }
    expect(effectiveEnd(m)).toBe(Date.parse(daysAgo(1)))
  })

  it('is null when neither is readable', () => {
    expect(effectiveEnd({})).toBeNull()
    expect(effectiveEnd({ validTo: 'nonsense' })).toBeNull()
  })
})

describe('deciding whether to withdraw a mirror', () => {
  it('leaves a permit that has not expired alone', () => {
    expect(shouldWithdraw(live(), NOW)).toEqual({ withdraw: false, reason: 'within-window' })
  })

  // The documented safety decision this must not break: a permit that lapsed
  // while work carried on is exactly the one somebody should be able to read
  // and challenge.
  it('leaves a recently expired permit readable, so it can still be challenged', () => {
    expect(shouldWithdraw(live({ validTo: daysAgo(1) }), NOW).withdraw).toBe(false)
    expect(shouldWithdraw(live({ validTo: daysAgo(6) }), NOW).withdraw).toBe(false)
  })

  // ...and the half that was missing: the challenge window has an end.
  it('withdraws once the challenge window has passed', () => {
    expect(shouldWithdraw(live({ validTo: daysAgo(8) }), NOW))
      .toEqual({ withdraw: true, reason: 'stale' })
    expect(shouldWithdraw(live({ validTo: daysAgo(400) }), NOW).withdraw).toBe(true)
  })

  it('holds the boundary day open rather than closing it early', () => {
    expect(shouldWithdraw(live({ validTo: daysAgo(STALE_AFTER_DAYS) }), NOW).withdraw).toBe(false)
  })

  it('honours an approved extension that is still in the future', () => {
    const m = live({ validTo: daysAgo(30), extension: { newValidTo: daysAhead(1) } })
    expect(shouldWithdraw(m, NOW).withdraw).toBe(false)
  })

  // Idempotence. Without this a large backlog is rewritten every night.
  it('skips one that is already withdrawn', () => {
    expect(shouldWithdraw({ ...live({ validTo: daysAgo(400) }), withdrawn: true }, NOW))
      .toEqual({ withdraw: false, reason: 'already-withdrawn' })
  })

  // The app treats a permit with no window as in progress. Withdrawing it would
  // take a barrier check away from work the system still considers live.
  it('never withdraws a permit with no readable end date', () => {
    expect(shouldWithdraw({ token: 't' }, NOW)).toEqual({ withdraw: false, reason: 'no-end-date' })
    expect(shouldWithdraw({ token: 't', validTo: null }, NOW).withdraw).toBe(false)
  })

  it('refuses nothing at all rather than crashing on it', () => {
    expect(shouldWithdraw(null, NOW).withdraw).toBe(false)
    expect(shouldWithdraw(undefined, NOW).withdraw).toBe(false)
  })
})

describe('what a withdrawal writes', () => {
  const w = withdrawnFields()

  // Every field that describes the job or names a person.
  it('blanks the describing fields and the one published name', () => {
    expect(w.jobDescription).toBe('')
    expect(w.jobLocation).toBe('')
    expect(w.issuedToName).toBe('')
    expect(w.issuingDepartment).toBe('')
    expect(w.hazards).toEqual([])
    expect(w.jsa).toEqual([])
  })

  it('zeroes the crew counts', () => {
    expect(w.participantCount).toBe(0)
    expect(w.fireWatcherCount).toBe(0)
    expect(w.hasConfinedWatcher).toBe(false)
  })

  // A scan afterwards must say "this permit is over", not 404 — which reads as
  // a wrong code and sends somebody hunting for a permit that did its job.
  it('says it was withdrawn rather than deleting the document', () => {
    expect(w.withdrawn).toBe(true)
    expect(Object.keys(w)).not.toContain('permitNo')
    expect(Object.keys(w)).not.toContain('storedStatus')
  })
})

describe('planning a run', () => {
  it('takes the stale and says why it left the rest', () => {
    const { withdraw, skipped } = planWithdrawals([
      { token: 'old', validTo: daysAgo(30) },
      { token: 'fresh', validTo: daysAgo(1) },
      { token: 'done', validTo: daysAgo(30), withdrawn: true },
      { token: 'undated' },
    ], { now: NOW })

    expect(withdraw).toEqual(['old'])
    expect(skipped).toEqual([
      { token: 'fresh', reason: 'within-window' },
      { token: 'done', reason: 'already-withdrawn' },
      { token: 'undated', reason: 'no-end-date' },
    ])
  })

  it('stops at the per-run cap and reports being capped', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ token: `t${i}`, validTo: daysAgo(30) }))
    const { withdraw, capped } = planWithdrawals(many, { now: NOW, max: 5 })
    expect(withdraw).toHaveLength(5)
    expect(capped).toBe(true)
  })

  it('is not capped when everything fits', () => {
    expect(planWithdrawals([{ token: 'a', validTo: daysAgo(30) }], { now: NOW }).capped).toBe(false)
    expect(MAX_WITHDRAWALS_PER_RUN).toBeGreaterThan(0)
  })

  it('survives junk in the batch', () => {
    expect(planWithdrawals([null, undefined], { now: NOW }).withdraw).toEqual([])
    expect(planWithdrawals().withdraw).toEqual([])
  })
})
