// ─────────────────────────────────────────────────────────────────────────────
// Which documents this viewer is allowed to ask for.
//
// Firestore security rules are not filters. If a query would return one
// document the rules refuse, the WHOLE query fails — it does not come back
// shorter. So once site-level documents are restricted, the library can no
// longer ask for everything and let the server sort it out: the query has to
// describe exactly the set the rule permits, or a member sees nothing at all.
//
// That failure would be silent, too. The module service swallows a read error
// into an empty list, so getting this wrong renders an empty library rather
// than an error anyone would report. Hence this file, and hence it being pure:
// the plan is worth testing on its own.
//
// The plan:
//   elevated (admin | manager | auditor) → one unfiltered query
//   everyone else → visibility == 'all', PLUS siteId in <sites they can reach>
//
// The server is the control (stack/policy.mjs siteBlocked): it returns only
// documents marked for everyone or filed at a site the viewer reaches, for
// managers and auditors as well as employees — only admins reach every site.
// It filters rather than refusing the whole query, so the unfiltered query
// for elevated roles simply comes back as their share.
// ─────────────────────────────────────────────────────────────────────────────

import { VISIBLE_ALL } from './classification'

/** Roles the rule lets past the site check. Keep in step with isElevatedOf(). */
export const ELEVATED_ROLES = ['admin', 'manager', 'auditor']

// Firestore caps an `in` filter at 30 values, so a viewer with more reachable
// sites than that needs more than one query. Splitting is the only option that
// stays correct; capping would drop documents with nothing on screen to say so.
export const IN_LIMIT = 30

export const isElevated = (role) => ELEVATED_ROLES.includes(String(role || ''))

export function chunk(list, size = IN_LIMIT) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * The queries to run for this viewer.
 *
 * @param role  the viewer's role
 * @param sites the sites they can already see (useAccessibleSites)
 * @returns [{ field, op, value }] — one entry per query to open and merge
 */
export function readPlan(role, sites = []) {
  if (isElevated(role)) return [{ field: null, op: null, value: null }]

  const ids = [...new Set((sites || []).map((s) => String(s?.id || '')).filter(Boolean))]
  const plan = [{ field: 'visibility', op: '==', value: VISIBLE_ALL }]
  // A member mapped to no site still gets the org-wide library, which is the
  // whole point of the level existing.
  chunk(ids).forEach((c) => plan.push({ field: 'siteId', op: 'in', value: c }))
  return plan
}

/**
 * Merge the results of those queries into one list.
 *
 * Deduped by id because a document could in principle satisfy two of them, and
 * re-sorted because the merge of several ordered lists is not itself ordered.
 * Newest first, matching the single-query case so the two paths cannot be told
 * apart by looking at the screen.
 */
export function mergeResults(lists = []) {
  const byId = new Map()
  lists.filter(Boolean).forEach((rows) => {
    const list = rows || []
    list.forEach((r) => {
      if (r && r.id) byId.set(r.id, r)
    })
  })
  return [...byId.values()].sort((a, b) => ms(b.createdAt) - ms(a.createdAt))
}

// createdAt is a Firestore Timestamp on saved records and can be missing on one
// that has just been written locally; both must sort without throwing.
function ms(v) {
  if (!v) return 0
  if (typeof v.toMillis === 'function') return v.toMillis()
  if (typeof v.seconds === 'number') return v.seconds * 1000
  const t = new Date(v).getTime()
  return Number.isNaN(t) ? 0 : t
}
