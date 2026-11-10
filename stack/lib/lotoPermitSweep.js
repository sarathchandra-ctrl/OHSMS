// The one scheduled job left behind LOTO isolation permits.
//
// The permits were removed from the app at the owner's request (2026-11-10),
// and with them the five-minute sweep that flagged active permits due or
// overdue. Records already stored are still kept to their retention period:
//
//   purgeClosedLotoPermits   nightly: delete permits closed more than a year ago,
//                            with their events, attachments and stored files.
//
// Planning is pure (isPurgeable). The loop takes its handles as arguments so it
// is tested without them, the same split retention.js uses.

/** Closed permits are kept this long after closure (owner decision: 1 year). */
export const LOTO_PERMIT_RETENTION_DAYS = 365

/**
 * One run may delete at most this many permits. A mistake in the query then
 * costs one run's worth, not the table — the same argument as MAX_PURGES_PER_RUN.
 */
export const MAX_PERMIT_PURGES_PER_RUN = 500

export const CLOSED_STATUSES = ['returned', 'rejected', 'withdrawn', 'emergency_removed']

function ms(value) {
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  if (typeof value?.toMillis === 'function') return value.toMillis()
  if (typeof value?._seconds === 'number') return value._seconds * 1000
  return Number.NaN
}

/** Closed for more than the retention period, and never an open permit. */
export function isPurgeable(permit, nowMs, days = LOTO_PERMIT_RETENTION_DAYS) {
  if (!permit || !CLOSED_STATUSES.includes(permit.status)) return false
  const closed = ms(permit.closedAt)
  // No closure time: keep it. A permit we cannot date is not one we can prove
  // is a year old, and deletion is the irreversible direction.
  if (!Number.isFinite(closed)) return false
  return nowMs - closed >= days * 24 * 60 * 60 * 1000
}
