// Give older records the siteId the access rules read.
//
// The server restricts a record to the people who reach its site, but only
// when the record names its site by id (policy.siteBlocked). Records written
// before the site register existed name it by text — a centre name, a site or
// location field — and so stay visible to everyone who can see the module.
// This plans the siteId for each, using the same tiered, refuse-when-ambiguous
// matching as the equipment linker (./siteLinks.js resolveSite): one site or
// nothing, never a best guess. A wrong siteId would hide a record from the
// people of its real site and show it to another site's.
//
// Pure: the Maintenance job (src/shared/org/siteBackfill.js) reads the records
// and writes the plan.

import { indexSites, resolveSite } from './siteLinks.js'

/**
 * Collections whose older records name their site in text, and the fields to
 * try, most specific first. The same fields the portal matches on by name
 * (src/pages/portal/portalStats.js). `signages` is left out for the reason
 * siteLinks.js gives: its writer does not keep a siteId.
 */
export const SITE_TEXT_FIELDS = {
  incidents: ['site', 'location'],
  mockDrills: ['centerName', 'site', 'siteName'],
  consultations: ['site', 'siteName', 'centerName', 'location'],
  permits: ['site', 'siteName', 'jobLocation'],
  extinguishers: ['centerName'],
  aeds: ['centerName'],
  fas: ['centerName'],
}

/**
 * For each record without a siteId: the one site its text names, or why not.
 * Returns { writes: [{ collection, id, siteId, siteName }], ambiguous, unmatched, sited }.
 */
export function planSiteBackfill(rowsByCollection = {}, sites = []) {
  const index = indexSites(sites)
  const writes = []
  const ambiguous = []
  const unmatched = []
  let sited = 0
  for (const [collection, fields] of Object.entries(SITE_TEXT_FIELDS)) {
    for (const row of rowsByCollection[collection] || []) {
      if (row?.siteId) {
        sited += 1
        continue
      }
      let outcome = null
      for (const field of fields) {
        const r = resolveSite(row?.[field], sites, { index })
        if (r.status === 'matched' || r.status === 'ambiguous') {
          outcome = { ...r, text: String(row[field]) }
          break
        }
      }
      const label = { collection, id: row?.id, text: outcome?.text || fields.map((f) => row?.[f]).find(Boolean) || '' }
      if (outcome?.status === 'matched') {
        writes.push({ collection, id: row.id, siteId: outcome.site.id, siteName: outcome.site.name })
      } else if (outcome?.status === 'ambiguous') ambiguous.push(label)
      else unmatched.push(label)
    }
  }
  return { writes, ambiguous, unmatched, sited }
}
