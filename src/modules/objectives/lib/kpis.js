// ─────────────────────────────────────────────────────────────────────────────
// Objectives & Targets — pure KPI computation.
//
// Every KPI is measured from the modules that already own the data, at three
// levels: org → region → site. No numbers are entered by hand; targets are.
// ─────────────────────────────────────────────────────────────────────────────

export const LEVELS = [
  { key: 'org', label: 'Organization' },
  { key: 'region', label: 'Region' },
  { key: 'site', label: 'Site' },
]

/** KPI registry. `levels` limits where a KPI is meaningful. */
export const KPIS = [
  {
    key: 'auditPass',
    label: 'Audit Pass %',
    unit: '%',
    higherIsBetter: true,
    levels: ['org', 'region'],
    byEntity: true,
    defaultTarget: 90,
    help: 'Audits closed with no Major or Minor non-conformity, as a share of audits conducted.',
    source: 'Internal Audit',
  },
  {
    key: 'ticketClosure',
    label: 'Ticket Closure %',
    unit: '%',
    higherIsBetter: true,
    levels: ['org', 'region'],
    byEntity: true,
    defaultTarget: 95,
    help: 'Corrective action tickets completed, as a share of all tickets raised across modules.',
    source: 'Action Tracker',
  },
  {
    key: 'extinguisherUptime',
    label: 'Fire Extinguisher Uptime %',
    unit: '%',
    higherIsBetter: true,
    levels: ['org', 'region', 'site'],
    defaultTarget: 98,
    help: 'Extinguishers with no open physical defect, as a share of all units.',
    source: 'Emergency Equipment',
  },
  {
    key: 'fasUptime',
    label: 'FAS Uptime %',
    unit: '%',
    higherIsBetter: true,
    levels: ['org', 'region', 'site'],
    defaultTarget: 98,
    help: 'Fire alarm system devices in operational status, as a share of all devices.',
    source: 'Emergency Equipment',
  },
  {
    key: 'signageUptime',
    label: 'Signage Uptime %',
    unit: '%',
    higherIsBetter: true,
    levels: ['org', 'region', 'site'],
    defaultTarget: 95,
    help: 'Safety signage with status Deployed (compliant), as a share of all signage records — Planned, Removed and Not set count as non-compliant.',
    source: 'Emergency Equipment',
  },
  {
    key: 'incidents',
    label: 'Incidents',
    unit: '',
    higherIsBetter: false,
    levels: ['org', 'region', 'site'],
    defaultTarget: 0,
    help: 'Injury incidents (first aid, lost time, reportable) in the period. Near misses and property damage are not counted. Target is the maximum acceptable.',
    source: 'Incidents',
  },
]

export const KPI_BY_KEY = Object.fromEntries(KPIS.map((k) => [k.key, k]))

// ── Scope filtering ──────────────────────────────────────────────────────────

/** Does a record fall inside {level, scope}? Records carry region/entity/siteId. */
export function inScope(rec, level, scope, entity = 'all') {
  if (!rec) return false
  if (entity !== 'all' && (rec.entity || '') !== entity) return false
  if (level === 'org') return true
  if (level === 'region') return (rec.region || '') === scope
  if (level === 'site') return (rec.siteId || '') === scope
  return false
}

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null)

// ── Periods ──────────────────────────────────────────────────────────────────
// A target's period was a free-text label that nothing read: actuals were
// all-time and FY2025 and FY2026 targets collided. These are the labels it
// understands; anything else means all time, and the scorecard says so.
//   2026            calendar year
//   FY2026          Indian financial year, 1 Apr 2026 – 31 Mar 2027
//   FY2026-27       the same, written out (FY2026-2027 too)
//   Q3 2026         calendar quarter
const utc = (y, m, d = 1) => Date.UTC(y, m, d)

/** { from, to, label } in UTC ms (to exclusive) for a period label, or null. */
export function periodRange(label) {
  const s = String(label || '').trim().toUpperCase().replace(/\s+/g, ' ')
  let m = s.match(/^FY ?(\d{4})(?: ?[-–/] ?(\d{2}|\d{4}))?$/)
  if (m) {
    const y = Number(m[1])
    if (m[2]) {
      const end = m[2].length === 2 ? Math.floor(y / 100) * 100 + Number(m[2]) : Number(m[2])
      if (end !== y + 1) return null
    }
    return { from: utc(y, 3), to: utc(y + 1, 3), label: `FY${y}-${String(y + 1).slice(2)}` }
  }
  if ((m = s.match(/^(\d{4})$/))) return { from: utc(+m[1], 0), to: utc(+m[1] + 1, 0), label: m[1] }
  if ((m = s.match(/^Q([1-4]) ?(\d{4})$/))) {
    const q = Number(m[1]) - 1
    return { from: utc(+m[2], q * 3), to: utc(+m[2], q * 3 + 3), label: `Q${m[1]} ${m[2]}` }
  }
  return null
}

/** Is a date (ISO string, ms, or {seconds}/{toMillis}) inside a range? No range: yes. */
export function inPeriod(date, range) {
  if (!range) return true
  let t = NaN
  if (typeof date === 'number') t = date
  else if (typeof date === 'string') t = Date.parse(date.length === 10 ? `${date}T00:00:00Z` : date)
  else if (date?.toMillis) t = date.toMillis()
  else if (typeof date?.seconds === 'number') t = date.seconds * 1000
  if (Number.isNaN(t)) return false
  return t >= range.from && t < range.to
}


// ── Individual KPIs ──────────────────────────────────────────────────────────

/**
 * Audit pass rate. An audit report passes when it raised no Major NC and no
 * Minor NC (observations and OFIs don't fail an audit).
 */
export function auditPass(reports = [], level = 'org', scope = '', entity = 'all', range = null) {
  // Only audits that have been through to the end: one still "Reported" has
  // findings nobody has answered yet, and counted as a pass or fail too early.
  const mine = reports.filter(
    (r) =>
      /^closed$/i.test(String(r.status || '')) &&
      inScope(scopeOfAudit(r), level, scope, entity) &&
      inPeriod(r.auditDate || r.createdAt, range)
  )
  const passed = mine.filter(
    (r) => !(r.findings || []).some((f) => /major nc|minor nc/i.test(f?.type || '')),
  ).length
  return { value: pct(passed, mine.length), numerator: passed, denominator: mine.length }
}

/** Audit reports keep their scope under taskDetails; normalise it. */
const scopeOfAudit = (r) => ({
  region: r.region || r.taskDetails?.region || '',
  entity: r.entity || r.taskDetails?.entity || '',
  siteId: r.siteId || r.taskDetails?.siteId || '',
})

/** Ticket closure across all modules (Action Tracker normalised actions). */
export function ticketClosure(actions = [], level = 'org', scope = '', entity = 'all', range = null) {
  // Actions due in the period; an action with no due date counts in all-time only.
  const mine = actions.filter(
    (a) => inScope(a, level, scope, entity) && (range ? a.due && inPeriod(a.due, range) : true)
  )
  const done = mine.filter((a) => a.status === 'done').length
  return { value: pct(done, mine.length), numerator: done, denominator: mine.length }
}

/** Extinguishers with no open physical defect (resolved defects are removed). */
export function extinguisherUptime(units = [], level = 'org', scope = '', entity = 'all') {
  const mine = units.filter((u) => !u.deletedAt && inScope(u, level, scope, entity))
  const up = mine.filter((u) => (u.physicalDefects || []).length === 0).length
  return { value: pct(up, mine.length), numerator: up, denominator: mine.length }
}

/** Fire alarm devices reporting operational. */
export function fasUptime(devices = [], level = 'org', scope = '', entity = 'all') {
  const mine = devices.filter((d) => !d.deletedAt && inScope(d, level, scope, entity))
  const up = mine.filter((d) => (d.status || 'operational') === 'operational').length
  return { value: pct(up, mine.length), numerator: up, denominator: mine.length }
}

/** Signage that is Deployed (compliant). */
export function signageUptime(signs = [], level = 'org', scope = '', entity = 'all') {
  const mine = signs.filter((s) => !s.deletedAt && inScope(s, level, scope, entity))
  const up = mine.filter((s) => s.status === 'Deployed').length
  return { value: pct(up, mine.length), numerator: up, denominator: mine.length }
}

/** Incident count (lower is better). */
const INJURY_TYPES = ['first_aid', 'lost_time', 'reportable']

export function incidentCount(incidents = [], level = 'org', scope = '', entity = 'all', range = null) {
  // Injuries in the period. It counted every incident ever, near misses,
  // property damage and deleted reports included.
  const mine = incidents.filter(
    (i) =>
      !i.deletedAt &&
      INJURY_TYPES.includes(i.type) &&
      inScope(i, level, scope, entity) &&
      inPeriod(i.incidentDate || i.createdAt, range)
  )
  return { value: mine.length, numerator: mine.length, denominator: mine.length }
}

/** Compute one KPI from the raw module data. */
// Equipment uptime is the state now; a period does not apply to it.
export const PERIOD_KPIS = ['auditPass', 'ticketClosure', 'incidents']

export function computeKpi(key, data, level, scope, entity = 'all', range = null) {
  switch (key) {
    case 'auditPass': return auditPass(data.auditReports, level, scope, entity, range)
    case 'ticketClosure': return ticketClosure(data.actions, level, scope, entity, range)
    case 'extinguisherUptime': return extinguisherUptime(data.extinguishers, level, scope, entity)
    case 'fasUptime': return fasUptime(data.fas, level, scope, entity)
    case 'signageUptime': return signageUptime(data.signages, level, scope, entity)
    case 'incidents': return incidentCount(data.incidents, level, scope, entity, range)
    default: return { value: null, numerator: 0, denominator: 0 }
  }
}

// ── Target comparison ────────────────────────────────────────────────────────

export const RAG = {
  on_track: { key: 'on_track', label: 'On target', tone: 'green', color: '#16a34a' },
  at_risk: { key: 'at_risk', label: 'At risk', tone: 'amber', color: '#d97706' },
  off_track: { key: 'off_track', label: 'Off target', tone: 'red', color: '#dc2626' },
  no_data: { key: 'no_data', label: 'No data', tone: 'gray', color: '#8a7660' },
}

/**
 * RAG status of an actual against its target. "At risk" is within 5 points
 * (or 20% of target for count KPIs) of missing.
 */
export function ragFor(kpiKey, value, target) {
  const kpi = KPI_BY_KEY[kpiKey]
  if (value == null || target == null || target === '') return RAG.no_data
  const t = Number(target)
  if (Number.isNaN(t)) return RAG.no_data
  if (kpi?.higherIsBetter) {
    if (value >= t) return RAG.on_track
    return value >= t - 5 ? RAG.at_risk : RAG.off_track
  }
  // Lower is better (incidents)
  if (value <= t) return RAG.on_track
  return value <= t + Math.max(1, t * 0.2) ? RAG.at_risk : RAG.off_track
}

/**
 * Find the target that applies to a KPI at a given scope, falling back to
 * org. Where several targets match (FY2025 and FY2026), the one whose period
 * covers `now` wins, then one with no readable period, then the latest.
 */
export function targetFor(objectives = [], kpiKey, level, scope, entity = 'all', now = Date.now()) {
  const match = (o) => o.kpi === kpiKey && (o.entity || 'all') === entity
  const rank = (o) => {
    const r = periodRange(o.period)
    if (r && now >= r.from && now < r.to) return 3e15
    if (!r) return 2e15
    return r.to
  }
  const best = (list) => list.sort((a, b) => rank(b) - rank(a))[0]
  return (
    best(objectives.filter((o) => match(o) && o.level === level && (o.scope || '') === (scope || ''))) ||
    best(objectives.filter((o) => match(o) && o.level === 'org')) ||
    best(objectives.filter((o) => o.kpi === kpiKey && o.level === 'org' && (o.entity || 'all') === 'all')) ||
    null
  )
}

/** The range a KPI is measured over for a target: its period, or all time. */
const rangeFor = (kpiKey, obj) => (PERIOD_KPIS.includes(kpiKey) ? periodRange(obj?.period) : null)

/**
 * Build a scorecard: one row per KPI valid at this level, with actual, target
 * and RAG.
 */
export function buildScorecard(data, objectives, level, scope, entity = 'all') {
  return KPIS.filter((k) => k.levels.includes(level)).map((k) => {
    const obj = targetFor(objectives, k.key, level, scope, entity)
    const range = rangeFor(k.key, obj)
    const result = computeKpi(k.key, data, level, scope, entity, range)
    const target = obj ? Number(obj.target) : null
    return {
      kpi: k,
      ...result,
      target,
      objective: obj,
      period: PERIOD_KPIS.includes(k.key) ? range?.label || 'all time' : 'now',
      rag: ragFor(k.key, result.value, target),
    }
  })
}

/** Roll a KPI across every scope value at a level — the drill-down table. */
export function breakdown(data, objectives, kpiKey, level, scopes, entity = 'all') {
  return scopes.map((s) => {
    const obj = targetFor(objectives, kpiKey, level, s.value, entity)
    const result = computeKpi(kpiKey, data, level, s.value, entity, rangeFor(kpiKey, obj))
    const target = obj ? Number(obj.target) : null
    return { ...s, ...result, target, rag: ragFor(kpiKey, result.value, target) }
  })
}
