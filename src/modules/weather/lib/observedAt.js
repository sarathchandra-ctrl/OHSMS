// The same label the digest mail prints (stack/lib/observedAt.js). The
// functions package cannot import the SPA, so the two have to move together.
// Asia/Kolkata is UTC+05:30 all year. The provider stamps UTC.

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `YYYY-MM-DDTHH+0530` with HH at 00, 06, 12 or 18. Same key as the digest slot. */
export function weatherSlot(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const ist = new Date(d.getTime() + IST_OFFSET_MS)
  const hour = Math.floor(ist.getUTCHours() / 6) * 6
  const pad = String(hour).padStart(2, '0')
  const y = ist.getUTCFullYear()
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0')
  const day = String(ist.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}T${pad}+0530`
}

/** `23 Sep, 16:30 IST`, or '' when the value is not a timestamp. */
export function formatObservedAt(value) {
  const ms = observedAtMs(value)
  if (!Number.isFinite(ms)) return ''
  const ist = new Date(ms + IST_OFFSET_MS)
  const hh = String(ist.getUTCHours()).padStart(2, '0')
  const mm = String(ist.getUTCMinutes()).padStart(2, '0')
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]}, ${hh}:${mm} IST`
}

export function asOfLabel(value) {
  const formatted = formatObservedAt(value)
  return formatted ? `As of ${formatted}` : ''
}

function observedAtMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return NaN
  const zoned = /Z$|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text.replace(/\.\d+$/, '')}Z`
  const ms = Date.parse(zoned)
  return Number.isFinite(ms) ? ms : NaN
}
