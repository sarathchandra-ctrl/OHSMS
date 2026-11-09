// ─────────────────────────────────────────────────────────────────────────────
// Calendar dates, in the user's own timezone.
//
// Every date the user types in this app is a CALENDAR date — the day an
// incident happened, the day a drill was run, the day a committee met. Not an
// instant. So it is formatted from local calendar fields and never through
// toISOString(), which converts to UTC: anywhere east of Greenwich that returns
// yesterday for most of the evening. `fire/lib/hpt.js` carries the same warning,
// having been bitten by it on a five-year compliance date.
//
// Five modules each declared their own `todayISO` — actions, cctv, hira,
// incidents, training. They agree today, which is luck rather than design. This
// is the one to import from; those five should migrate to it when their files
// are next opened for another reason.
// ─────────────────────────────────────────────────────────────────────────────

/** Today as YYYY-MM-DD in the browser's timezone. */
export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Hydrostatic due dates are counted on the Asia/Kolkata calendar, the same day
// stack/lib/siteSummary.js uses for the WhatsApp site summary. The rest of
// this file stays on the browser's calendar: a refill date and an incident
// date are the day the user picked, and moving those would change every list.
// 18:30 UTC is midnight in Kolkata, so a browser left on UTC calls a test due
// tomorrow while the message the site manager just received already calls it
// due today.
const IST_OFFSET_MS = 330 * 60 * 1000

/** 'YYYY-MM-DD' for an instant, on the Asia/Kolkata calendar. */
export function istDay(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * Is this YYYY-MM-DD after today?
 *
 * String comparison, deliberately. Both sides are zero-padded YYYY-MM-DD, which
 * sorts lexicographically exactly as it sorts chronologically, so this needs no
 * Date parsing and cannot pick up a timezone on the way through.
 *
 * An empty or malformed value is NOT future — "you have not filled this in" is a
 * different complaint, and the required-field check is the one that should make
 * it.
 */
export function isFutureDate(value, today = todayISO()) {
  if (!value || typeof value !== 'string') return false
  return value > today
}

/**
 * `days` from today, as YYYY-MM-DD in the browser's timezone.
 *
 * The pairing that goes wrong is `setDate` with `toISOString`: setDate works in
 * LOCAL calendar fields and toISOString converts to UTC, so in UTC+5:30 a due
 * date computed before 05:30 comes back a day early. On a Major NC that is
 * seven days becoming six, which is the difference between a corrective action
 * being late and not.
 */
export function addDaysISO(days, from = new Date()) {
  // A YYYY-MM-DD string is rebuilt from its own fields rather than parsed.
  // `new Date('2026-09-04')` is UTC midnight, and setDate/getDate then work in
  // LOCAL fields — so at a negative UTC offset the arithmetic starts a day
  // early. That mismatch is what made a certificate expiring in exactly thirty
  // days read as `valid` instead of `expiring`.
  const base = typeof from === 'string'
    ? (() => {
        const [y, m, d] = from.split('-').map(Number)
        return y && m && d ? new Date(y, m - 1, d) : new Date()
      })()
    : from
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  d.setDate(d.getDate() + Number(days || 0))
  return todayISO(d)
}

/**
 * Anything that might be a date, as YYYY-MM-DD in the browser's timezone — or
 * '' when it is not a date at all.
 *
 * Firestore Timestamp, Date, ISO string, millis. Every branch is validated,
 * which the audit module's own toDate() did not do: it guarded the string
 * branch with Number.isNaN and let a corrupt Timestamp through, so the screen
 * printed the literal "Invalid Date" and isOverdue compared NaN — which is
 * false for every operator, reporting an overdue action as on time.
 *
 * A date-only string is taken at its word rather than parsed. `new
 * Date('2026-09-30')` is UTC midnight, so west of Greenwich it is the 29th
 * locally; the string already says which day it means.
 */
export function toISODate(value) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})/)
    if (m) return m[1]
  }
  let d = null
  if (typeof value?.toDate === 'function') {
    try { d = value.toDate() } catch { return '' }
  } else if (value instanceof Date) {
    d = value
  } else {
    d = new Date(value)
  }
  return d instanceof Date && !Number.isNaN(d.getTime()) ? todayISO(d) : ''
}

/**
 * Is this due date in the past?
 *
 * Compares YYYY-MM-DD strings, which sort chronologically and cannot pick up a
 * timezone on the way through. `new Date(due) < new Date()` could not do that:
 * a date-only string parses as UTC midnight, so an action due TODAY showed a
 * red Overdue badge from 05:30 that morning in IST — for the whole working day
 * on which it was not yet late.
 *
 * Strictly before today. An action due today is due, not overdue.
 */
export function isOverdueDate(value, { closed = false, today = todayISO() } = {}) {
  if (closed) return false
  const iso = toISODate(value)
  return Boolean(iso) && iso < today
}
