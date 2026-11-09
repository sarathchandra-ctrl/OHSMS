import { subscribeOrgUsers as sharedOrgUsers } from '../../../shared/org/orgData'

const createdMs = (u) => {
  const c = u?.createdAt
  if (!c) return 0
  if (typeof c.toMillis === 'function') return c.toMillis()
  const t = new Date(c).getTime()
  return Number.isNaN(t) ? 0 : t
}

/**
 * Subscribe to all users within an organization (admin view). Backed by the
 * shared ref-counted org-users listener; this module expects `id` instead of
 * `uid` and newest-first ordering, so adapt the shared rows.
 */
export function subscribeOrgUsers(callback) {
  return sharedOrgUsers((users) => {
    const rows = users.map(({ uid, ...rest }) => ({ id: uid, ...rest }))
    rows.sort((a, b) => createdMs(b) - createdMs(a))
    callback(rows)
  })
}
