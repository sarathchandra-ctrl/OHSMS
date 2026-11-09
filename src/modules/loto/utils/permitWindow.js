// ─────────────────────────────────────────────────────────────────────────────
// The shift window of a permit, and what "due" and "overdue" mean against it.
//
// A window is two ABSOLUTE instants. Everything that makes shifts awkward lives
// in building them, not in comparing them: a night shift 22:00–06:00 is stored
// as 22:00 on the day it starts and 06:00 on the next, so "is it overdue" is
// always `now > windowEnd` and midnight never has to be thought about again.
// The failure this avoids is the one a time-of-day comparison has — a 22:00–06:00
// permit read at 01:00 looks like 01:00 < 22:00 and "not yet started".
//
// Pure. The scheduler (stack/lib/lotoPermitSweep.js) restates the same
// comparison with the SERVER clock; the browser uses its own clock for the
// badge only, and the stored flag written by the scheduler wins when they differ.
// ─────────────────────────────────────────────────────────────────────────────
import { DUE_SOON_MINUTES, MAX_WINDOW_HOURS, OPEN_STATUSES } from '../constants/permits'

const MIN = 60 * 1000
const HOUR = 60 * MIN

/** Milliseconds from a Firestore Timestamp, Date, ISO string or number; NaN if none. */
export function toMs(value) {
  if (value == null || value === '') return NaN
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  if (typeof value.toMillis === 'function') return value.toMillis()
  if (typeof value.seconds === 'number')
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6)
  const t = Date.parse(value)
  return Number.isNaN(t) ? NaN : t
}

const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Build a window from a date and two clock times.
 *
 * `end <= start` means the shift crosses midnight, so the end lands on the
 * NEXT day. An end equal to the start is therefore a 24-hour window, which is
 * allowed at the limit and refused beyond it by validateWindow.
 *
 * Returns { startMs, endMs, crossesMidnight } or null when an input is
 * malformed — never a window built from NaN, which would sort and compare as
 * "never overdue".
 */
export function windowFromShift({ date, start, end }) {
  const d = YMD.exec(String(date || ''))
  const s = HM.exec(String(start || ''))
  const e = HM.exec(String(end || ''))
  if (!d || !s || !e) return null
  const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])]
  const startDate = new Date(y, m - 1, day, Number(s[1]), Number(s[2]), 0, 0)
  if (
    startDate.getFullYear() !== y ||
    startDate.getMonth() !== m - 1 ||
    startDate.getDate() !== day
  ) {
    return null // 2026-02-31 and friends
  }
  let endDate = new Date(y, m - 1, day, Number(e[1]), Number(e[2]), 0, 0)
  const crossesMidnight = endDate.getTime() <= startDate.getTime()
  if (crossesMidnight) endDate = new Date(y, m - 1, day + 1, Number(e[1]), Number(e[2]), 0, 0)
  return { startMs: startDate.getTime(), endMs: endDate.getTime(), crossesMidnight }
}

/** Why a window is not acceptable, or '' when it is. */
export function windowProblem(startMs, endMs, { nowMs = Date.now() } = {}) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs))
    return 'Enter a valid start and end for the shift window.'
  if (endMs <= startMs) return 'The window must end after it starts.'
  if (endMs - startMs > MAX_WINDOW_HOURS * HOUR) {
    return `A permit window cannot be longer than ${MAX_WINDOW_HOURS} hours.`
  }
  if (endMs <= nowMs) return 'The window has already ended.'
  return ''
}

/**
 * Where a permit stands against its window at `nowMs`.
 *
 *   upcoming  the window has not opened
 *   running   inside the window, more than DUE_SOON_MINUTES left
 *   due       inside the last DUE_SOON_MINUTES
 *   overdue   past the end
 *
 * `msToEnd` is negative once overdue. The state describes the CLOCK only; the
 * caller decides whether it matters (a closed permit is never overdue).
 */
export function windowState(permit, nowMs = Date.now(), dueMinutes = DUE_SOON_MINUTES) {
  const startMs = toMs(permit?.windowStart)
  const endMs = toMs(permit?.windowEnd)
  if (!Number.isFinite(endMs)) return { state: 'unknown', msToEnd: NaN, overdueMs: 0 }
  const msToEnd = endMs - nowMs
  if (msToEnd <= 0) return { state: 'overdue', msToEnd, overdueMs: -msToEnd }
  if (msToEnd <= dueMinutes * MIN) return { state: 'due', msToEnd, overdueMs: 0 }
  if (Number.isFinite(startMs) && nowMs < startMs)
    return { state: 'upcoming', msToEnd, overdueMs: 0 }
  return { state: 'running', msToEnd, overdueMs: 0 }
}

/** "1 h 05 m" / "12 m" / "now" for a non-negative span. */
export function formatSpan(ms) {
  if (!Number.isFinite(ms)) return '—'
  const total = Math.max(0, Math.round(ms / MIN))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0 && m === 0) return 'now'
  if (h === 0) return `${m} m`
  return `${h} h ${String(m).padStart(2, '0')} m`
}

/** "YYYY-MM-DD" in the browser's zone — the default for the date input. */
export function localDateInput(ms = Date.now()) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * What the screen shows for a permit's clock, or null when the clock no longer
 * matters. Only a permit that is still OPEN has one: a closed permit is never
 * "overdue", it is history.
 *
 * `flags` are written by the server scheduler against the SERVER clock
 * (stack/lib/lotoPermitSweep.js: `dueAt`, `overdueCount`, keyed to the
 * `windowEnd` they were computed for). They win over this browser's clock in the
 * escalating direction: a laptop whose clock is an hour slow must not show
 * "running" for a permit the server has already flagged overdue. They never make
 * a permit LESS late, and flags for an older window (before an extension) are
 * ignored.
 */
export function permitClock(permit, nowMs = Date.now()) {
  if (!permit || !OPEN_STATUSES.includes(permit.status)) return null
  const local = windowState(permit, nowMs)
  const flags = permit.flags
  if (flags && flags.windowEnd === toMs(permit.windowEnd)) {
    if (flags.overdueCount > 0 && local.state !== 'overdue') {
      const since = Number(flags.overdueSince)
      return {
        ...local,
        state: 'overdue',
        overdueMs: Math.max(local.overdueMs, Number.isFinite(since) ? nowMs - since : 0, 0),
      }
    }
    if (flags.dueAt && (local.state === 'running' || local.state === 'upcoming')) {
      return { ...local, state: 'due' }
    }
  }
  return local
}
