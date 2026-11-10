// Adapter: map unified platform roles onto permit-to-work's role model
// (admin / engineering / operations / technician) and expose the derived
// isAdmin / isApprover flags the module's UI and PermitContext expect.
import { createModuleAuth } from '../../../shared/auth/moduleAuth'
import { ROLES, isApprover as roleIsApprover, isAdmin as roleIsAdmin } from '../lib/permissions'

export { AuthProvider } from '../../../shared/auth/AuthContext'

const ROLE_MAP = {
  admin: ROLES.ADMIN,
  manager: ROLES.ADMIN, // safety officer → full approve/close authority
  member: ROLES.TECHNICIAN, // create permits
  auditor: ROLES.TECHNICIAN,
}

// platformRole keeps the role ROLE_MAP collapsed: a manager and an
// Administrator are both ADMIN here, but only the Administrator may decide a
// re-approval pinned to someone else (lib/permissions.js canActForTeam).
export const useAuth = createModuleAuth(ROLE_MAP, ROLES.TECHNICIAN, (a, role, profile) => ({
  profile: profile ? { ...profile, roles: [role], platformRole: a.role } : profile,
  isAdmin: roleIsAdmin(role),
  isApprover: roleIsApprover(role),
}))
