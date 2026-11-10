// ─────────────────────────────────────────────────────────────────────────────
// Derived status for the AED, FAS and stretcher asset registers. Pure functions
// over a list
// held in memory (same pattern as extinguisherLogic). Dates reuse toDate/
// daysUntil so a corrupt value degrades to null instead of crashing.
// ─────────────────────────────────────────────────────────────────────────────
import { daysUntil } from './extinguisherLogic'
import { AED_STATUS, FAS_STATUS, STRETCHER_STATUS } from './constants'

export const DUE_SOON = 30

// ── Unique asset IDs ──────────────────────────────────────────────────────────
// Sequential, human-readable IDs like "AED-0001" / "FAS-0001". Take the highest
// numeric suffix already in use for the prefix and add one, so every asset gets
// a unique, stable identifier without the user having to invent one.
export function highestAssetSeq(prefix, list, field) {
  let max = 0
  for (const a of list || []) {
    const v = String(a?.[field] || '')
    const m = v.match(/-(\d+)$/)
    if (m && v.startsWith(`${prefix}-`)) max = Math.max(max, parseInt(m[1], 10))
  }
  return max
}
export function formatAssetId(prefix, n) {
  return `${prefix}-${String(n).padStart(4, '0')}`
}
// nextAssetId() lived here — highestAssetSeq + 1, computed in the browser. It
// is gone rather than deprecated: leaving it exported is how the next register
// gets colliding ids. Numbers now come from reserveAssetIds() in lib/data,
// which reserves them in a transaction; highestAssetSeq survives as the FLOOR
// that seeds a counter against a register numbered before it existed.

// 'expired' | 'due' (within DUE_SOON days) | 'ok' | null (no/invalid date)
export function dueState(value, today = new Date()) {
  const d = daysUntil(value, today)
  if (d === null) return null
  if (d <= 0) return 'expired'
  if (d <= DUE_SOON) return 'due'
  return 'ok'
}
const flagged = (s) => s === 'expired' || s === 'due'

/**
 * Text colour for a due state, on amber+white glass.
 *
 * Three tables share this palette — the extinguisher DueCell and the AED / FAS
 * / stretcher date cells — so the colours live here rather than in four files.
 * Four copies is how they drifted below the line together without anyone
 * comparing them.
 *
 * White frost over amber canvas (`#f6e3bb`, composited card ~`#fcf7ec`). Logo
 * siren / amber / kraft, darkened onto those surfaces so "in 300d" still
 * clears AA:
 *   expired #991b1b   due #92400e   ok #6b5744
 */
export const DUE_TEXT_COLOR = {
  expired: '#991b1b',
  due: '#92400e',
  ok: '#6b5744',
}
export const dueTextColor = (state) => DUE_TEXT_COLOR[state] || DUE_TEXT_COLOR.ok

// ── AED ──────────────────────────────────────────────────────────────────────
export function aedCondition(a, today = new Date()) {
  const states = [
    dueState(a.batteryExpiry, today),
    dueState(a.padExpiry, today),
    dueState(a.nextInspection, today),
  ]
  const expired = a.status === AED_STATUS.OUT_OF_SERVICE || states.includes('expired')
  const due = !expired && (a.status === AED_STATUS.SERVICE_DUE || states.includes('due'))
  return { expired, due, ok: !expired && !due }
}
export function aedColor(a, today = new Date()) {
  const c = aedCondition(a, today)
  return c.expired ? '#dc2626' : c.due ? '#f59e0b' : '#16a34a'
}
// An AED with the key details missing (battery/pad expiry or site) — the record
// exists (and has a QR) but its data still needs entering.
export function aedIncomplete(a) {
  return !a?.centerName || !a?.batteryExpiry || !a?.padExpiry
}

export function aedSummary(list, today = new Date()) {
  const s = {
    total: list.length,
    ready: 0,
    due: 0,
    outOfService: 0,
    batteryExpiring: 0,
    padExpiring: 0,
    inspectionDue: 0,
    incomplete: 0,
  }
  for (const a of list) {
    const c = aedCondition(a, today)
    if (a.status === AED_STATUS.OUT_OF_SERVICE) s.outOfService++
    else if (c.due || c.expired) s.due++
    else s.ready++
    if (flagged(dueState(a.batteryExpiry, today))) s.batteryExpiring++
    if (flagged(dueState(a.padExpiry, today))) s.padExpiring++
    if (flagged(dueState(a.nextInspection, today))) s.inspectionDue++
    if (aedIncomplete(a)) s.incomplete++
  }
  return s
}

// ── FAS ──────────────────────────────────────────────────────────────────────
export function fasCondition(a, today = new Date()) {
  const svc = dueState(a.nextService, today)
  const expired = a.status === FAS_STATUS.FAULTY || svc === 'expired'
  const due = !expired && (a.status === FAS_STATUS.SERVICE_DUE || svc === 'due')
  return { expired, due, ok: !expired && !due }
}
export function fasColor(a, today = new Date()) {
  const c = fasCondition(a, today)
  return c.expired ? '#dc2626' : c.due ? '#f59e0b' : '#16a34a'
}
// FAS panels need no extra details, so "incomplete" only means a missing site.
export function fasIncomplete(a) {
  return !a?.centerName
}

export function fasSummary(list, today = new Date()) {
  const s = { total: list.length, operational: 0, due: 0, faulty: 0, serviceDue: 0, incomplete: 0 }
  for (const a of list) {
    const c = fasCondition(a, today)
    if (a.status === FAS_STATUS.FAULTY) s.faulty++
    else if (c.due || c.expired) s.due++
    else s.operational++
    if (flagged(dueState(a.nextService, today))) s.serviceDue++
    if (fasIncomplete(a)) s.incomplete++
  }
  return s
}

// ── Stretchers ───────────────────────────────────────────────────────────────
// The same shape as an AED — one unit, one inspection cycle, one status — with
// one date rather than three. A stretcher has no battery and no pads: what goes
// wrong with it is physical and is found by looking, which is why the QR defect
// sheet matters more here than any expiry field would.
export function stretcherCondition(a, today = new Date()) {
  const insp = dueState(a.nextInspection, today)
  const expired = a.status === STRETCHER_STATUS.OUT_OF_SERVICE || insp === 'expired'
  const due = !expired && (a.status === STRETCHER_STATUS.SERVICE_DUE || insp === 'due')
  return { expired, due, ok: !expired && !due }
}
export function stretcherColor(a, today = new Date()) {
  const c = stretcherCondition(a, today)
  return c.expired ? '#dc2626' : c.due ? '#f59e0b' : '#16a34a'
}
// A stretcher whose record exists but whose key details are still blank. The
// inspection date counts as a key detail here because it is the ONLY date on
// the record: without it the unit can never become due, so it would sit green
// forever having been looked at once, or never.
export function stretcherIncomplete(a) {
  return !a?.centerName || !a?.nextInspection
}

export function stretcherSummary(list, today = new Date()) {
  const s = {
    total: list.length,
    ready: 0,
    due: 0,
    outOfService: 0,
    inspectionDue: 0,
    incomplete: 0,
  }
  for (const a of list) {
    const c = stretcherCondition(a, today)
    if (a.status === STRETCHER_STATUS.OUT_OF_SERVICE) s.outOfService++
    else if (c.due || c.expired) s.due++
    else s.ready++
    if (flagged(dueState(a.nextInspection, today))) s.inspectionDue++
    if (stretcherIncomplete(a)) s.incomplete++
  }
  return s
}
