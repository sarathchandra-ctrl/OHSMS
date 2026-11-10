// ─────────────────────────────────────────────────────────────────────────────
// The portal's stat widgets.
//
// The home page used to show one fixed row of six figures, chosen once for
// everybody. A fire officer and a training coordinator do not want the same six,
// and the ones they do not want are the ones that stop the row being read at
// all. So the set is a catalogue and each person picks from it.
//
// Every widget is defined here rather than in the page: the picker, the grid and
// the defaults all read the same list, so adding one is a single entry and
// nothing can list a widget that cannot be computed.
//
// `value` takes the already-scoped data the page holds and returns a number, or
// null when the widget cannot answer (no data loaded yet). Widgets never compute
// their own scope — the page has already narrowed everything to the sites this
// viewer may see, and a widget reaching around that would leak.
// ─────────────────────────────────────────────────────────────────────────────
import {
  CloudSun, AlertTriangle, ListChecks, GraduationCap, FireExtinguisher, Wrench,
  HeartPulse, HeartCrack, BellRing, BellOff, FileText, FileCheck, TimerReset,
  FileWarning, FileLock2, ShieldAlert, Users, Siren,
} from 'lucide-react'

/** Groups order the picker. */
export const WIDGET_GROUPS = ['Safety', 'Emergency equipment', 'Permits', 'Activity']

// Statuses that mean an asset would not work when it was needed. Same reading
// as the analytics module, so the two cannot disagree about fleet health.
const AED_BAD = new Set(['out_of_service', 'service_due'])
const FAS_BAD = new Set(['faulty', 'service_due'])

const len = (v) => (Array.isArray(v) ? v.length : 0)

export const WIDGETS = [
  // ── Safety ────────────────────────────────────────────────────────────────
  {
    key: 'weather',
    label: 'Weather risk',
    icon: CloudSun,
    hint: 'Highest weather risk across your sites',
    group: 'Safety',
    tone: '#7fc4bb',
    // Rendered by its own component — it is a band and a phrase, not a count.
    kind: 'weather',
    to: '/weather',
  },
  {
    key: 'incidents',
    label: 'Incidents',
    icon: AlertTriangle,
    hint: 'Recorded at your sites',
    group: 'Safety',
    tone: '#a855f7',
    to: '/incidents',
    value: (d) => d.stats?.counts?.incidents ?? null,
  },
  {
    key: 'pendingActions',
    label: 'Pending actions',
    icon: ListChecks,
    hint: 'Assigned to you, not yet done',
    group: 'Safety',
    tone: '#dd5a41',
    to: '/actions',
    value: (d) => (d.myOpenActions == null ? null : d.myOpenActions),
  },
  {
    key: 'pendingTraining',
    label: 'Pending training',
    icon: GraduationCap,
    hint: 'Assigned to you, not yet completed',
    group: 'Safety',
    tone: '#8fbc74',
    to: '/portal/training',
    value: (d) => (d.myPendingTraining == null ? null : d.myPendingTraining),
  },

  // ── Emergency equipment ───────────────────────────────────────────────────
  {
    key: 'extinguishers',
    label: 'Fire extinguishers',
    icon: FireExtinguisher,
    hint: 'Deployed at your sites',
    group: 'Emergency equipment',
    tone: '#dd5a41',
    to: '/equipment/extinguishers',
    value: (d) => d.stats?.counts?.extinguishers ?? null,
  },
  {
    key: 'extinguisherDefects',
    label: 'Extinguishers with defects',
    icon: Wrench,
    hint: 'A logged defect on the unit',
    group: 'Emergency equipment',
    tone: '#b91c1c',
    alertWhenAbove: 0,
    to: '/equipment/physical-open',
    value: (d) => (d.extinguishers ? d.extinguishers.filter((e) => len(e.physicalDefects) > 0).length : null),
  },
  {
    key: 'aeds',
    label: 'AED units',
    icon: HeartPulse,
    hint: 'Deployed at your sites',
    group: 'Emergency equipment',
    tone: '#7fc4bb',
    to: '/equipment/aed',
    value: (d) => d.stats?.counts?.aeds ?? null,
  },
  {
    key: 'aedDefects',
    label: 'AEDs with defects',
    icon: HeartCrack,
    hint: 'Out of service or service due',
    group: 'Emergency equipment',
    tone: '#b91c1c',
    alertWhenAbove: 0,
    to: '/equipment/aed',
    value: (d) => (d.aeds ? d.aeds.filter((a) => AED_BAD.has(a.status)).length : null),
  },
  {
    key: 'fas',
    label: 'Fire alarm panels',
    icon: BellRing,
    hint: 'Deployed at your sites',
    group: 'Emergency equipment',
    tone: '#e8a33d',
    to: '/equipment/fas',
    value: (d) => d.stats?.counts?.fas ?? null,
  },
  {
    key: 'fasDefects',
    label: 'Panels with defects',
    icon: BellOff,
    hint: 'Faulty or service due',
    group: 'Emergency equipment',
    tone: '#b91c1c',
    alertWhenAbove: 0,
    to: '/equipment/fas',
    value: (d) => (d.fas ? d.fas.filter((f) => FAS_BAD.has(f.status)).length : null),
  },

  // ── Permits ───────────────────────────────────────────────────────────────
  {
    key: 'permitsOpen',
    label: 'Permits open',
    icon: FileText,
    hint: 'Raised, awaiting approval',
    group: 'Permits',
    tone: '#64748b',
    to: '/permits',
    value: (d) => d.permits?.open ?? null,
  },
  {
    key: 'permitsInProgress',
    label: 'Permits in progress',
    icon: FileCheck,
    hint: 'Approved, work under way',
    group: 'Permits',
    tone: '#2563eb',
    to: '/permits',
    value: (d) => d.permits?.inProgress ?? null,
  },
  {
    key: 'permitsExtended',
    label: 'Permits extended',
    icon: TimerReset,
    hint: 'Running past the original window',
    group: 'Permits',
    tone: '#7c3aed',
    to: '/permits',
    value: (d) => d.permits?.extended ?? null,
  },
  {
    key: 'permitsExpired',
    label: 'Permits expired',
    icon: FileWarning,
    hint: 'Past their window and not closed',
    group: 'Permits',
    tone: '#dc2626',
    alertWhenAbove: 0,
    to: '/permits',
    value: (d) => d.permits?.notClosed ?? null,
  },
  {
    key: 'permitsClosed',
    label: 'Permits closed',
    icon: FileLock2,
    hint: 'Work finished and signed off',
    group: 'Permits',
    tone: '#334155',
    to: '/permits',
    value: (d) => d.permits?.closed ?? null,
  },
  {
    key: 'permitsUnsafe',
    label: 'Permits — unsafe reported',
    icon: ShieldAlert,
    hint: 'An unanswered unsafe observation',
    group: 'Permits',
    tone: '#ea580c',
    alertWhenAbove: 0,
    to: '/permits',
    value: (d) => d.permits?.withObservations ?? null,
  },

  // ── Activity ──────────────────────────────────────────────────────────────
  {
    key: 'meetings',
    label: 'Committee meetings',
    icon: Users,
    hint: 'Conducted at your sites',
    group: 'Activity',
    tone: '#8ba7bd',
    to: '/committee',
    value: (d) => (d.meetings == null ? null : d.meetings),
  },
  {
    key: 'drills',
    label: 'Mock drills',
    icon: Siren,
    hint: 'Conducted at your sites',
    group: 'Activity',
    tone: '#e8a33d',
    to: '/mock-drills',
    value: (d) => (d.drills == null ? null : d.drills),
  },
]

export const WIDGET_BY_KEY = Object.fromEntries(WIDGETS.map((w) => [w.key, w]))

/**
 * What a new person sees before they have chosen anything.
 *
 * Six, matching the row this replaced, and weighted to what most people open
 * the portal for rather than to what is cheapest to compute.
 */
export const DEFAULT_WIDGETS = [
  'pendingActions', 'pendingTraining', 'incidents',
  'extinguishers', 'extinguisherDefects', 'weather',
]

/**
 * Clean a stored selection.
 *
 * Keys are dropped rather than trusted: a widget removed in a later release
 * would otherwise be read back from a saved preference and crash the grid. An
 * empty result falls back to the defaults, because a portal with no widgets
 * looks broken rather than customised.
 */
export function normalizeSelection(keys) {
  if (!Array.isArray(keys)) return [...DEFAULT_WIDGETS]
  const seen = new Set()
  const out = []
  for (const k of keys) {
    if (typeof k !== 'string' || !WIDGET_BY_KEY[k] || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out.length ? out : [...DEFAULT_WIDGETS]
}

/** The catalogue grouped for the picker, in `WIDGET_GROUPS` order. */
export function widgetsByGroup() {
  return WIDGET_GROUPS
    .map((group) => ({ group, items: WIDGETS.filter((w) => w.group === group) }))
    .filter((g) => g.items.length > 0)
}
