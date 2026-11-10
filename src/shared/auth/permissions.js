// ─────────────────────────────────────────────────────────────────────────────
// Unified role-based access control for the whole OHS platform.
//
// Four roles reconcile the varied role sets across the source modules
// (reporter/investigator/admin, admin/member, …):
//
//   admin    — full access incl. users, roles and org settings
//   manager  — approve/close records, manage sites, delete; safety-officer level
//   member   — create & edit records in every module (standard user)
//   auditor  — read-only across all modules incl. the audit log
//
// UI gates on can(role, action); Firestore rules enforce tenant + member access.
// This is the single source of truth for what each role may do.
// ─────────────────────────────────────────────────────────────────────────────

export const ROLES = [
  { key: 'admin', label: 'Admin', desc: 'Full access incl. users, roles and settings.' },
  {
    key: 'manager',
    label: 'Manager / Safety Officer',
    desc: 'Every module, for the regions, entities and sites assigned. Cannot manage employees or permissions.',
  },
  {
    key: 'member',
    label: 'Employee',
    desc: 'The modules and sites they are given; several sites may be assigned.',
  },
  { key: 'auditor', label: 'Auditor', desc: 'Read-only access across all modules.' },
]
export const ROLE_BY_KEY = Object.fromEntries(ROLES.map((r) => [r.key, r]))
export const roleLabel = (key) => ROLE_BY_KEY[key]?.label || key

const RANK = { admin: 4, manager: 3, member: 2, auditor: 1 }
export const rankOf = (role) => RANK[role] || 0

// Capability → roles allowed (besides admin, who can do everything).
const MATRIX = {
  'record.view': ['manager', 'member', 'auditor'],
  'record.create': ['manager', 'member'],
  'record.edit': ['manager', 'member'],
  'record.close': ['manager'],
  'record.delete': ['manager'],
  'action.manage': ['manager', 'member'],
  'site.manage': ['manager'],
  'audit.view': ['manager', 'auditor'],
  'user.manage': [], // admin only
  'org.settings': [], // admin only
}

/** True if `role` may perform `action`. Admin can do everything. */
export function can(role, action) {
  if (role === 'admin') return true
  const allowed = MATRIX[action]
  if (!allowed) return false
  return allowed.includes(role)
}

/** Read-only roles see modules but cannot mutate. */
export const isReadOnly = (role) => role === 'auditor'

/**
 * Everyone approved can view every module; the sidebar shows all modules and
 * per-action gates (create/edit/close) handle finer control. `adminOnly`
 * modules (Users, Org Settings) are gated separately in the registry.
 */
