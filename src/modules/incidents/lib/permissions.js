// ─────────────────────────────────────────────────────────────────────────────
// Role-based capability checks. Three roles: reporter < investigator < admin.
// UI gates on can(role, action); stack/policy.mjs enforces what each person
// may actually read and write. Keep this the single source of truth for what each role may do.
// ─────────────────────────────────────────────────────────────────────────────

export const ROLES = [
  { key: 'reporter', label: 'Reporter', desc: 'Report incidents, injuries and illnesses.' },
  { key: 'investigator', label: 'Investigator', desc: 'Run teams, investigations and actions.' },
  { key: 'admin', label: 'Admin', desc: 'Full access incl. users and settings.' },
]
export const ROLE_BY_KEY = Object.fromEntries(ROLES.map((r) => [r.key, r]))

// Capability → roles allowed. Admin is implicitly allowed everything.
const MATRIX = {
  'incident.create': ['reporter', 'investigator'],
  'incident.report': ['reporter', 'investigator'], // step 1 + injury reports
  'incident.investigate': ['investigator'], // team / investigation / CAPA / horizontal
  'incident.close': ['investigator'],
  'incident.delete': [], // admin only
  'illness.create': ['reporter', 'investigator'],
  'illness.report': ['reporter', 'investigator'],
  'illness.delete': [],
  'action.manage': ['investigator'], // create / update / close actions
  'injury.verify': ['investigator'], // verify standalone injury reports
  'user.manage': [],
  'audit.view': [],
  'recycle.manage': [],
}

/** True if `role` may perform `action`. Admin can do everything. */
export function can(role, action) {
  if (role === 'admin') return true
  const allowed = MATRIX[action]
  if (!allowed) return false
  return allowed.includes(role)
}

export const roleLabel = (key) => ROLE_BY_KEY[key]?.label || key
