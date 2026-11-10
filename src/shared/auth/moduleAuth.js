import { useAuth as useSharedAuth } from './AuthContext'

// ─────────────────────────────────────────────────────────────────────────────
// Module role adapters.
//
// Several modules were ported in from separate applications, each with its own
// role vocabulary — incidents thinks in reporter/investigator/admin, LOTO in
// admin/safety/engineering/technician, PTW in admin/engineering/operations/
// technician. Rather than rewrite every `can(role, …)` and role gate in those
// modules, each one keeps its own vocabulary and translates at the boundary.
//
// That translation was eight near-identical files. Three of them (fire, hira,
// inspections) were byte-for-byte identical and a fourth (committee) differed
// by one token; the rest differed only in the extra fields their ported code
// expects. This factory is the shared half. What stays per-module is the ROLE
// MAP — which is the part that is genuinely a decision — and any extra shape.
//
// Note what is NOT here: none of this is a permission control. The mapped role
// decides what the UI offers. What the user may actually do is decided by
// stack/policy.mjs against their REAL platform role, which this never touches.
// A module that maps `manager` to its own `admin` is not granting anything.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a module's `useAuth` hook.
 *
 * @param {object} roleMap   platform role → this module's role
 * @param {string} fallback  role for anyone the map does not name
 * @param {function} [extend]  (shared, role, profile) → extra fields to merge on
 *   top of the standard shape. Use it for the ported-code accessors a module
 *   cannot do without; returning `profile` replaces the mapped one.
 */
export function createModuleAuth(roleMap, fallback, extend) {
  return function useModuleAuth() {
    const shared = useSharedAuth()
    const role = roleMap[shared.role] || fallback
    // getUserProfile already returns { uid, ...doc }, so uid is present without
    // being re-set here — several of the old copies spread `uid: user?.uid` on
    // top of a profile that already had it.
    const profile = shared.profile ? { ...shared.profile, role } : shared.profile
    const base = { ...shared, role, profile, isAdmin: shared.isAdmin }
    return extend ? { ...base, ...extend(shared, role, profile) } : base
  }
}

/**
 * The map most modules use: the platform's four roles collapsed onto a plain
 * admin/member split. Shared because four modules had their own copy of it and
 * a fifth would have made a fifth.
 */
export const ADMIN_MEMBER_ROLES = {
  admin: 'admin',
  manager: 'admin',
  member: 'member',
  auditor: 'member',
}
