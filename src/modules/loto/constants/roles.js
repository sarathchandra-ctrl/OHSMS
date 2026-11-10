// ---------------------------------------------------------------------------
// Role-Based Access Control model for HECP / LOTO operations.
// Permission keys are the single source of truth used across every phase.
// ---------------------------------------------------------------------------

export const PERMISSIONS = {
  PROCEDURE_VIEW: 'procedure.view',
  PROCEDURE_CREATE: 'procedure.create',
  PROCEDURE_REVISE: 'procedure.revise',
  PROCEDURE_SEND_FOR_APPROVAL: 'procedure.sendForApproval',
  PROCEDURE_APPROVE: 'procedure.approve',
  PROCEDURE_DELETE: 'procedure.delete',
  LOTO_PERFORM: 'loto.perform',
  USERS_MANAGE: 'users.manage',
}

export const ROLES = {
  ADMIN: 'admin',
  SAFETY: 'safety',
  ENGINEERING: 'engineering',
  TECHNICIAN: 'technician',
}

const P = PERMISSIONS

// Default permission set seeded onto a user when a role is assigned.
// An admin can then grant/revoke individual permissions beyond this default.
export const ROLE_PERMISSIONS = {
  [ROLES.ADMIN]: Object.values(P),
  [ROLES.SAFETY]: [
    P.PROCEDURE_VIEW,
    P.PROCEDURE_CREATE,
    P.PROCEDURE_REVISE,
    P.PROCEDURE_APPROVE,
    P.PROCEDURE_DELETE,
    P.LOTO_PERFORM,
  ],
  [ROLES.ENGINEERING]: [
    P.PROCEDURE_VIEW,
    P.PROCEDURE_CREATE,
    P.PROCEDURE_REVISE,
    P.PROCEDURE_SEND_FOR_APPROVAL,
    P.LOTO_PERFORM,
  ],
  [ROLES.TECHNICIAN]: [P.PROCEDURE_VIEW, P.LOTO_PERFORM],
}

export const ROLE_META = {
  [ROLES.ADMIN]: {
    label: 'Administrator',
    short: 'Admin',
    description: 'Full access to all modules and user management.',
    color: '#e23b2e',
    accent: 'bg-danger/15 text-danger border-danger/40',
  },
  [ROLES.SAFETY]: {
    label: 'Safety Team',
    short: 'Safety',
    description: 'Create, approve, revise & delete procedures; perform LOTO.',
    color: '#f5a800',
    accent: 'bg-amber-100 text-amber-800 border-amber-300',
  },
  [ROLES.ENGINEERING]: {
    label: 'Engineering Team',
    short: 'Engineering',
    description: 'Create & revise procedures, send for approval, perform LOTO.',
    color: '#506f9b',
    accent: 'bg-steel-500/20 text-steel-300 border-steel-500/40',
  },
  [ROLES.TECHNICIAN]: {
    label: 'Technician',
    short: 'Technician',
    description: 'View procedures and perform LOTO actions.',
    color: '#2faa57',
    accent: 'bg-safe/15 text-safe border-safe/40',
  },
}

export const USER_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
}

/** Normalise a profile to multi-role: ensure roles[] and admin flag. */
export function rolesOf(profile) {
  if (Array.isArray(profile?.roles) && profile.roles.length) return profile.roles
  return profile?.role ? [profile.role] : []
}

// PERMISSION_LABELS, ASSIGNABLE_ROLES, permissionsForRole, permissionsForRoles
// and hasPermission were removed: they were the API for a per-user permission
// toggle screen that was never built, and nothing imported any of them. The
// model above (PERMISSIONS / ROLE_PERMISSIONS / ROLE_META) is what is live.
