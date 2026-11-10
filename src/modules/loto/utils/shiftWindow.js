// The permit window is a shift, not two times somebody typed.
//
// A request is open from REQUEST_LEAD_MINUTES before the shift starts until
// the shift ends. The same rule is in stack/policy.mjs (lotoWindowProblem):
// without a saved site configuration the server checks the default durations
// and the lead; once an Admin saves the site's clocks it checks those clocks.
import { REQUEST_LEAD_MINUTES, SHIFT_PRESETS } from '../constants/permits'

const MIN = 60 * 1000
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/

export function shiftKey(shift) {
  return shift?.id || shift?.key || ''
}

export function parseClock(value) {
  const m = HM.exec(String(value || ''))
  if (!m) return null
  return { h: Number(m[1]), min: Number(m[2]) }
}

/** Minutes from start to end. A night shift that wraps midnight is still positive. */
export function shiftDurationMinutes(start, end) {
  const s = parseClock(start)
  const e = parseClock(end)
  if (!s || !e) return null
  const a = s.h * 60 + s.min
  const b = e.h * 60 + e.min
  const span = b > a ? b - a : b + 1440 - a
  return span === 0 ? 1440 : span
}

function localParts(ms, zoneOffsetMinutes) {
  if (zoneOffsetMinutes == null) {
    const d = new Date(ms)
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() }
  }
  const local = new Date(ms + zoneOffsetMinutes * MIN)
  return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate() }
}

function stamp(parts, h, min, zoneOffsetMinutes, dayOffset) {
  if (zoneOffsetMinutes == null) {
    return new Date(parts.y, parts.m, parts.d + dayOffset, h, min, 0, 0).getTime()
  }
  return Date.UTC(parts.y, parts.m, parts.d + dayOffset, h, min) - zoneOffsetMinutes * MIN
}

/**
 * The occurrence of `shift` that is open at `nowMs`, or null.
 * Open means now is inside [start - lead, end). `zoneOffsetMinutes` is minutes
 * east of UTC (IST is 330). Null uses the browser's zone, which is what the
 * form does before a site has saved a zone.
 */
export function openShiftWindow(shift, nowMs = Date.now(), { leadMinutes = REQUEST_LEAD_MINUTES, zoneOffsetMinutes = null } = {}) {
  const start = parseClock(shift?.start)
  const end = parseClock(shift?.end)
  if (!start || !end) return null
  const lead = leadMinutes * MIN
  const startMin = start.h * 60 + start.min
  const endMin = end.h * 60 + end.min
  const crosses = endMin <= startMin
  const base = localParts(nowMs, zoneOffsetMinutes)
  for (const off of [-1, 0, 1]) {
    const startMs = stamp(base, start.h, start.min, zoneOffsetMinutes, off)
    const endMs = stamp(base, end.h, end.min, zoneOffsetMinutes, off + (crosses ? 1 : 0))
    if (nowMs < endMs && nowMs >= startMs - lead) {
      return {
        id: shiftKey(shift),
        label: shift.label || shiftKey(shift),
        startMs,
        endMs,
        crossesMidnight: crosses,
      }
    }
  }
  return null
}

/** Shifts for a site, or the defaults when that site has not been configured. */
export function shiftsForSite(settings, siteId) {
  const raw = settings?.sites?.[siteId]?.shifts
  if (!raw || typeof raw !== 'object') {
    return SHIFT_PRESETS.map((s) => ({ ...s, id: s.key }))
  }
  const list = Object.entries(raw)
    .map(([id, v]) => ({
      id,
      key: id,
      label: v?.label || id,
      start: v?.start,
      end: v?.end,
    }))
    .filter((s) => parseClock(s.start) && parseClock(s.end))
  return list.length ? list : SHIFT_PRESETS.map((s) => ({ ...s, id: s.key }))
}

/** Saved zone, or null to mean "the browser's zone". */
export function zoneForSite(settings, siteId) {
  const z = settings?.sites?.[siteId]?.zoneOffsetMinutes
  return Number.isInteger(z) ? z : null
}

/**
 * Why this draft's window is not the open shift, or ''.
 * A hand-typed start or end does not match the occurrence, so it is refused.
 */
export function shiftRequestProblem({
  shiftId,
  shifts,
  nowMs = Date.now(),
  windowStartMs,
  windowEndMs,
  leadMinutes = REQUEST_LEAD_MINUTES,
  zoneOffsetMinutes = null,
} = {}) {
  const shift = (shifts || []).find((s) => shiftKey(s) === shiftId)
  if (!shift) return 'Choose a shift. The start and end come from that shift.'
  const open = openShiftWindow(shift, nowMs, { leadMinutes, zoneOffsetMinutes })
  if (!open) {
    return `This shift is not open. A request can be raised from ${leadMinutes} minutes before it starts until it ends.`
  }
  if (windowStartMs !== open.startMs || windowEndMs !== open.endMs) {
    return 'The window is the shift. Start and end cannot be typed in.'
  }
  return ''
}

export function formatWindow(ms) {
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}
