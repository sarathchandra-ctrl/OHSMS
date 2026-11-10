// Who may approve, extend or emergency-remove a permit.
//
// The split the LOTO module uses for its buttons: an Admin with no site
// and no grant reaches every permit; anyone else reaches a permit only through
// its site or its entity. A region grant does not. Being named on the permit
// (or having raised it) is handled by the caller — this only answers scope.

const list = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v) : [])

export function reachesPermitSite(user, permit) {
  if (!user || user.role !== 'admin') return false
  if (user.status && user.status !== 'approved') return false
  const access = user.access && typeof user.access === 'object' ? user.access : {}
  const sites = list(access.sites)
  const entities = list(access.entities)
  const regions = list(access.regions)
  const unrestricted = !user.siteId && sites.length === 0 && entities.length === 0 && regions.length === 0
  if (unrestricted) return true
  const siteId = permit?.siteId || ''
  const entity = permit?.entity || ''
  if (siteId && (user.siteId === siteId || sites.includes(siteId))) return true
  if (entity && entities.includes(entity)) return true
  return false
}

export function isNamedOnPermit(uid, permit) {
  if (!uid || !permit) return false
  if (permit.requestedBy === uid) return true
  return Array.isArray(permit.personnelUids) && permit.personnelUids.includes(uid)
}

/** Another administrator who could approve this permit. Named crew cannot. */
export function otherApproverExists(users, permit) {
  return (users || []).some(
    (u) =>
      u?.uid &&
      u.uid !== permit?.requestedBy &&
      reachesPermitSite(u, permit) &&
      !(permit?.personnelUids || []).includes(u.uid),
  )
}
