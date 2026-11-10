// ─────────────────────────────────────────────────────────────────────────────
// Site-scoped access model. A user's granted access is a union of:
//   • specific sites        (access.sites: siteId[])
//   • whole regions         (access.regions: string[])  → every site in the region
//   • whole entities        (access.entities: string[]) → every site in the entity
// Admins implicitly access every site. Requests are stored on the profile as
// `accessRequest` and applied by an admin (see orgData.grantAccessRequest).
// ─────────────────────────────────────────────────────────────────────────────

export const DEPARTMENTS = ['Safety', 'Facility', 'Operation', 'Projects']

/**
 * Org-configured department list (Org Settings → General), falling back to the
 * built-in defaults. Use this everywhere a department dropdown is shown so
 * admin-added departments populate across all modules.
 */
export function orgDepartments(org) {
  const list = Array.isArray(org?.departments) ? org.departments.filter(Boolean) : []
  return list.length ? list : DEPARTMENTS
}

const arr = (v) => (Array.isArray(v) ? v : [])

/** Distinct regions / entities present in the site inventory (for dropdowns). */
export const regionsOf = (sites) =>
  [...new Set(arr(sites).map((s) => s.region).filter(Boolean))].sort()
export const entitiesOf = (sites) =>
  [...new Set(arr(sites).map((s) => s.entity).filter(Boolean))].sort()

/**
 * The concrete list of sites a user can access.
 *
 * Their own posting counts. `siteId` is where the employee actually works — set
 * when an admin provisions them — and until now it granted nothing, so someone
 * mapped to a site still resolved to zero and saw an empty portal: no counts,
 * no pending work, nothing about the place they stand in every day. An explicit
 * access grant remains the way to reach *other* sites; this only stops a person
 * being locked out of their own.
 */
export function resolveAccessibleSites(user, sites, { isAdmin } = {}) {
  const list = arr(sites)
  if (isAdmin || user?.role === 'admin') return list
  const a = user?.access || {}
  const s = new Set(arr(a.sites))
  if (user?.siteId) s.add(user.siteId)
  const r = new Set(arr(a.regions))
  const e = new Set(arr(a.entities))
  return list.filter((site) => s.has(site.id) || r.has(site.region) || e.has(site.entity))
}

export const hasPendingAccessRequest = (user) => {
  const r = user?.accessRequest
  return !!r && (arr(r.sites).length + arr(r.regions).length + arr(r.entities).length > 0)
}

/** Short human summary of a granted (or requested) scope. */
export function accessSummary(scope, sites = []) {
  if (!scope) return 'No access'
  const s = arr(scope.sites)
  const r = arr(scope.regions)
  const e = arr(scope.entities)
  if (s.length + r.length + e.length === 0) return 'No access'
  const nameOf = (id) => sites.find((x) => x.id === id)?.name || id
  const parts = []
  if (e.length) parts.push(`${e.length} ${e.length === 1 ? 'entity' : 'entities'}`)
  if (r.length) parts.push(`${r.length} region${r.length === 1 ? '' : 's'}`)
  if (s.length) parts.push(`${s.length} site${s.length === 1 ? '' : 's'}${s.length <= 2 ? ` (${s.map(nameOf).join(', ')})` : ''}`)
  return parts.join(' · ')
}

// ── Module permissions ──────────────────────────────────────────────────────
// Which modules a person may open, on top of what the organization has
// (entitlements). Admins, managers and auditors see every module the
// organization has; an employee (`member`) sees the ones granted in
// `access.modules`.
//
// ABSENT MEANS EVERY MODULE, the same rule entitlements use and for the same
// reason: every employee profile written before this field existed has no
// `access.modules`, and reading that as "none" would have emptied the portal
// for all of them the day this shipped. An admin narrows it by saving a list;
// an empty list is a deliberate "no modules".
//
// `access` is a privileged field (stack/policy.mjs, users_keep_privilege), so
// only an admin can change this list. It is not yet enforced per collection on
// the server: like site scope, it decides what the app offers.
const ALL_MODULE_ROLES = ['admin', 'manager', 'auditor']

/** null = every module; otherwise the Set of module keys this person may open. */
export function grantedModuleKeys(user) {
  if (ALL_MODULE_ROLES.includes(user?.role)) return null
  const list = user?.access?.modules
  return Array.isArray(list) ? new Set(list) : null
}

/** May this person open module `key`? (Entitlement is checked separately.) */
export function canUseModule(user, key) {
  const granted = grantedModuleKeys(user)
  return granted === null || granted.has(key)
}

/**
 * The entitlement map narrowed to this person's module permissions, so every
 * screen that already reads the map (portal, dashboard, field grid, route
 * gate, alert feed) follows the permission without its own check.
 */
export function personalModuleMap(moduleMap, user) {
  const granted = grantedModuleKeys(user)
  if (granted === null) return moduleMap
  return Object.fromEntries(
    Object.entries(moduleMap || {}).map(([key, on]) => [key, on && granted.has(key)])
  )
}

/**
 * Sites matching a Region / Entity / Site selection, where '' or 'all' in a
 * field means no restriction on it. Used by the portal's scope pickers.
 */
export function sitesInSelection(sites, { region = 'all', entity = 'all', siteId = 'all' } = {}) {
  const any = (v) => !v || v === 'all'
  return arr(sites).filter(
    (s) =>
      (any(region) || s.region === region) &&
      (any(entity) || s.entity === entity) &&
      (any(siteId) || s.id === siteId)
  )
}
