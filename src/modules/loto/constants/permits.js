// ─────────────────────────────────────────────────────────────────────────────
// The per-job LOTO permit, layered on top of the isolation procedures.
//
// A procedure says HOW to isolate a machine and is approved once; a permit says
// "this crew isolates it, for this job, in this window, and here is who agreed".
// The permit never replaces the procedure: it points at one APPROVED procedure,
// copies the isolation points it will use, and — when work starts — takes the
// procedure's locks in the same transaction that flips the permit (see
// services/permitActions.js). The two cannot disagree because they are never
// written apart.
//
// Lives at organizations/{orgId}/lotoPermits/{permitNo}. Path-tenanted on
// purpose: the root `procedures` / `locks` collections are tenanted by an orgId
// FIELD (docs/LOTO-COLLECTIONS.md), a pattern this module is not deepening.
// ─────────────────────────────────────────────────────────────────────────────

/** The controlling standard cited on screens and printouts. */
export const LOTO_STANDARD = 'OSHA 29 CFR 1910.147'
export const LOTO_STANDARD_TITLE = 'The control of hazardous energy (lockout/tagout)'

/** Permit number prefix: LP-<year>-<sequence>, one sequence per org per year. */
export const PERMIT_PREFIX = 'LP'

/** The collection name. */
export const PERMIT_COLLECTION = 'lotoPermits'

export const PERMIT_STATUS = {
  REQUESTED: 'requested',
  APPROVED: 'approved',
  ACTIVE: 'active',
  RETURNED: 'returned',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
  EMERGENCY_REMOVED: 'emergency_removed',
}

/** Terminal states. A permit in one of these is immutable (rules enforce it). */
export const CLOSED_STATUSES = [
  PERMIT_STATUS.RETURNED,
  PERMIT_STATUS.REJECTED,
  PERMIT_STATUS.WITHDRAWN,
  PERMIT_STATUS.EMERGENCY_REMOVED,
]

/** Open = still needs somebody to do something. */
export const OPEN_STATUSES = [
  PERMIT_STATUS.REQUESTED,
  PERMIT_STATUS.APPROVED,
  PERMIT_STATUS.ACTIVE,
]

export const isClosedStatus = (status) => CLOSED_STATUSES.includes(status)

/**
 * The status-transition whitelist. firestore.rules carries the same table
 * (the `lotoPermitMove` helper) — this copy drives the buttons and the
 * pure validators; the rules are the one that cannot be bypassed.
 */
export const PERMIT_TRANSITIONS = {
  [PERMIT_STATUS.REQUESTED]: [
    PERMIT_STATUS.APPROVED,
    PERMIT_STATUS.REJECTED,
    PERMIT_STATUS.WITHDRAWN,
  ],
  [PERMIT_STATUS.APPROVED]: [PERMIT_STATUS.ACTIVE, PERMIT_STATUS.WITHDRAWN],
  [PERMIT_STATUS.ACTIVE]: [PERMIT_STATUS.RETURNED, PERMIT_STATUS.EMERGENCY_REMOVED],
  [PERMIT_STATUS.RETURNED]: [],
  [PERMIT_STATUS.REJECTED]: [],
  [PERMIT_STATUS.WITHDRAWN]: [],
  [PERMIT_STATUS.EMERGENCY_REMOVED]: [],
}

export function canMove(from, to) {
  return (PERMIT_TRANSITIONS[from] || []).includes(to)
}

export const PERMIT_STATUS_META = {
  [PERMIT_STATUS.REQUESTED]: {
    label: 'Awaiting approval',
    accent: 'border-amber-300 bg-amber-100 text-amber-800',
  },
  [PERMIT_STATUS.APPROVED]: {
    label: 'Approved — not started',
    accent: 'border-sky-300 bg-sky-100 text-sky-800',
  },
  [PERMIT_STATUS.ACTIVE]: {
    label: 'Active — locked out',
    accent: 'border-danger/40 bg-danger/15 text-danger',
  },
  [PERMIT_STATUS.RETURNED]: {
    label: 'Returned',
    accent: 'border-safe/40 bg-safe/15 text-safe',
  },
  [PERMIT_STATUS.REJECTED]: {
    label: 'Rejected',
    accent: 'border-steel-600 bg-steel-800 text-steel-300',
  },
  [PERMIT_STATUS.WITHDRAWN]: {
    label: 'Withdrawn',
    accent: 'border-steel-600 bg-steel-800 text-steel-300',
  },
  [PERMIT_STATUS.EMERGENCY_REMOVED]: {
    label: 'Emergency removal',
    accent: 'border-danger/40 bg-danger/15 text-danger',
  },
}

/**
 * Work types. Every one is raised against a piece of equipment and an APPROVED
 * procedure of that equipment. Area / tag-only work was removed: a permit with
 * nothing to isolate is not a lockout permit.
 */
export const WORK_TYPES = [
  { key: 'machine_maintenance', label: 'Machine maintenance', requiresEquipment: true },
  { key: 'electrical_work', label: 'Electrical work', requiresEquipment: true },
]

export const workTypeByKey = (key) => WORK_TYPES.find((w) => w.key === key) || null
export const workTypeLabel = (key) => workTypeByKey(key)?.label || key || '—'
export const requiresEquipment = (key) => Boolean(workTypeByKey(key)?.requiresEquipment)

/**
 * Default shifts, used until an Admin saves times for a site. The window is
 * one of these (or the site's own list) — start and end are not typed.
 * A shift whose end is not after its start crosses midnight.
 */
export const SHIFT_PRESETS = [
  { key: 'A', label: 'Shift A (06:00–14:00)', start: '06:00', end: '14:00' },
  { key: 'B', label: 'Shift B (14:00–22:00)', start: '14:00', end: '22:00' },
  { key: 'C', label: 'Shift C (22:00–06:00, next day)', start: '22:00', end: '06:00' },
  { key: 'general', label: 'General (09:00–18:00)', start: '09:00', end: '18:00' },
]

/** A request may open this long before the shift starts. Mirrored in the rules. */
export const REQUEST_LEAD_MINUTES = 30

/** A window longer than this is not a shift. */
export const MAX_WINDOW_HOURS = 24

/** "Due" begins this long before the window end. */
export const DUE_SOON_MINUTES = 30

/** One extension can add at most this long (the rules cap it too). */
export const MAX_EXTENSION_HOURS = 24

/** Minimum length of a free-text justification (reason, emergency, extension). */
export const MIN_REASON_LENGTH = 10

/** Bounds, mirrored in firestore.rules so a hostile client cannot exceed them. */
export const LIMITS = {
  text: 2000,
  name: 120,
  workers: 50,
  locks: 100,
}

export const EVENT_TYPES = {
  REQUESTED: 'requested',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
  STARTED: 'started',
  EXTENDED: 'extended',
  RETURNED: 'returned',
  EMERGENCY_REMOVED: 'emergency_removed',
  DUE: 'due',
  OVERDUE: 'overdue',
}

/** Pre-energise checklist: every item must be affirmed to return a permit. */
export const RETURN_CHECKS = [
  { key: 'toolsRemoved', label: 'All tools, materials and test equipment removed from the machine' },
  { key: 'guardsReplaced', label: 'Guards and covers are back in place' },
  { key: 'personnelClear', label: 'All personnel are clear of the machine and danger zone' },
  { key: 'affectedNotified', label: 'Affected employees have been told the equipment is about to be re-energised' },
]

/** Attestations an emergency removal must carry. */
export const EMERGENCY_ATTESTATIONS = [
  { key: 'ownerUnavailable', label: 'The person who applied the lock could not be reached or is unavailable' },
  { key: 'equipmentInspected', label: 'The equipment has been inspected and is safe to re-energise' },
  { key: 'ownerWillBeTold', label: 'The lock owner will be told before they resume work' },
]
