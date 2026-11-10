// ─────────────────────────────────────────────────────────────────────────────
// Role-based access control. Pure + framework-free so it's unit-testable and
// shared by route guards, button gating and Firestore-facing helpers.
// ─────────────────────────────────────────────────────────────────────────────

export const ROLES = {
  ADMIN: 'admin',
  ENGINEERING: 'engineering',
  OPERATIONS: 'operations',
  TECHNICIAN: 'technician',
}

// Order/labels for the Users admin dropdown.
export const ROLE_OPTIONS = [
  { value: ROLES.ADMIN, label: 'Admin', color: '#ea580c', hint: 'Full access to every action' },
  { value: ROLES.ENGINEERING, label: 'Engineering', color: '#2563eb', hint: 'Create, edit, approve, close & extend' },
  { value: ROLES.OPERATIONS, label: 'Operations', color: '#16a34a', hint: 'Create, edit, approve, close & extend' },
  { value: ROLES.TECHNICIAN, label: 'Technician', color: '#64748b', hint: 'Create permits only' },
]

// The two approving teams. Admin can act on behalf of either.
export const TEAMS = { ENGINEERING: 'engineering', OPERATIONS: 'operations' }

export const APPROVER_ROLES = [ROLES.ADMIN, ROLES.ENGINEERING, ROLES.OPERATIONS]

export const isApprover = (role) => APPROVER_ROLES.includes(role)
export const isAdmin = (role) => role === ROLES.ADMIN

/** The team a role decides for. Admin → null (may act for either team). */
export function teamForRole(role) {
  if (role === ROLES.ENGINEERING) return TEAMS.ENGINEERING
  if (role === ROLES.OPERATIONS) return TEAMS.OPERATIONS
  return null
}

const isOwner = (profile, permit) => profile?.uid && permit?.createdBy === profile.uid

// A user may hold several roles. Read roles[] when present, else the single role.
const rolesOf = (profile) =>
  Array.isArray(profile?.roles) && profile.roles.length
    ? profile.roles
    : profile?.role
      ? [profile.role]
      : []

/**
 * Central capability check.
 *   can(profile, action, permit?)
 * Actions: create | view | edit | requestClosure | requestExtension |
 *          addSuggestion | manageUsers | viewAudit | decide
 * (Team-scoped decide gating uses canActForTeam below.)
 */
export function can(profile, action, permit = null) {
  const roles = rolesOf(profile)
  if (!roles.length) return false
  const approver = roles.some(isApprover)
  const admin = roles.includes(ROLES.ADMIN)

  switch (action) {
    case 'create':
      return true // every approved role can raise a permit
    case 'manageUsers':
    case 'viewAudit':
      return admin
    // Deleting a permit destroys the record of who authorised what work, which
    // is exactly what an investigation or an audit goes looking for. Admin only,
    // and even then it is meant for permits raised in error rather than as a
    // way to tidy up history.
    case 'delete':
      return admin
    case 'view':
      return approver || isOwner(profile, permit)
    case 'edit':
      // Approvers may edit a permit that isn't closed yet.
      return approver && permit && !permit.closure?.done
    case 'requestClosure':
    case 'requestExtension':
      // The raiser (incl. technician) on their own permit, or any approver/admin.
      return approver || isOwner(profile, permit)
    case 'addSuggestion':
      return approver
    case 'decide':
      return approver
    default:
      return false
  }
}

/**
 * May this user record/clear a decision for `team` on this permit?
 *  - admin: always (acts for either team)
 *  - engineering/operations: only their own team, and — if a specific approver
 *    is assigned for that team — only that assigned person.
 */
export function canActForTeam(profile, permit, team, block = null) {
  const roles = rolesOf(profile)
  if (!roles.length) return false
  // A rejection answered and sent back goes to the person who rejected it
  // alone (lib/rejection.js). Managers map to ADMIN here, so this comes
  // before the ADMIN shortcut; the platform Administrator still may decide,
  // as the server allows (stack/policy.mjs permitDecisionProblem).
  const pinned = block?.status === 'pending' && block.reapprover ? String(block.reapprover) : ''
  if (pinned) return profile?.uid === pinned || profile?.platformRole === 'admin'
  if (roles.includes(ROLES.ADMIN)) return true
  if (!roles.some((r) => teamForRole(r) === team)) return false
  const assigned = team === TEAMS.ENGINEERING ? permit?.assignedEngineer : permit?.assignedOperator
  if (assigned) return profile.uid === assigned
  return true
}
