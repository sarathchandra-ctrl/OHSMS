// The Activity log's helpers. They lived with the isolation permits, which are
// gone from the app; the log stays, and still holds the lock and permit events
// recorded before then (lotoEvents), inside the one-year retention window.

/** Milliseconds from a stored timestamp, Date, ISO string or number; NaN if none. */
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

/** The events matching a search and an action. Older events may name a permit. */
export function filterActivity(events = [], { q = '', action = '', fromMs = 0 } = {}) {
  const needle = q.trim().toLowerCase()
  return events.filter((e) => {
    const at = toMs(e.at)
    if (fromMs && !(at >= fromMs)) return false
    if (action && e.action !== action && e.type !== action) return false
    if (!needle) return true
    const hay = [e.action, e.type, e.byName, e.note, e.permitNo, e.equipment, e.detail].join(' ').toLowerCase()
    return hay.includes(needle)
  })
}
