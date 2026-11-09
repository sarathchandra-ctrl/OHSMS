// ─────────────────────────────────────────────────────────────────────────────
// How a warehouse row finds a site in this app's register.
//
// This used to live only in the ODIN dashboard. The WhatsApp
// lookup has to attribute an audit to a centre the same way, or a score
// the dashboard shows for DEMO001 is the score the phone says belongs to
// somebody else. functions/ cannot import the SPA, so the join lives here
// and the dashboard re-exports it.
//
// Nothing in this file may import node builtins or metabase.js. The
// dashboard bundle imports it, and metabase.js pulls in node:dns.
// ─────────────────────────────────────────────────────────────────────────────

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * A site name reduced to what two systems can be expected to agree on.
 *
 * Internal runs of whitespace collapse as well as the ends being trimmed:
 * "Cult  Pitampura" and "Cult Pitampura" are one centre, and a double space
 * pasted from a spreadsheet is an invisible reason for a join to miss. Matches
 * normName in parseSitesCsv.js, which decides the same question for the site
 * importer — the two disagreeing is how a name matches on one screen and not
 * on the other.
 */
export const normSiteName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

// The same name with punctuation and spacing thrown away, for the last-resort
// pass of the site join. See resolveOdinRows.
const looseKey = (s) => normSiteName(s).replace(/[^a-z0-9]/g, '')

/**
 * Where a site record may carry the warehouse's own id for it.
 *
 * `code` is the real one — Sites has a **Centre ID** box that writes it, the
 * CSV import and export both carry it, and the page refuses to let two sites
 * share one. The rest are read for tenants who put the id somewhere else before
 * that box existed, and are checked on the site document AND inside its
 * `attributes` map, so nothing anybody already recorded stops working.
 */
export const SITE_CODE_FIELDS = ['code', 'siteCode', 'centerId', 'centreId', 'centerServiceId', 'externalId']

/**
 * Fill in what the warehouse did not say, from the site register this app
 * already holds.
 *
 * A Metabase question almost never carries coordinates, and asking an
 * organization to add latitude and longitude columns to their analytics
 * warehouse in order to see a map is asking them to duplicate a register they
 * are already maintaining here. So the join runs the other way: match on site
 * id first — an exact key beats a name every time — then on the site's name,
 * case- and space-insensitively.
 *
 * Region and entity are filled in the same way and only where the row is
 * SILENT. A row that states its own region wins: the warehouse is the system of
 * record for the finding, and quietly overwriting what it said with what our
 * register believes is how two dashboards start disagreeing.
 *
 * ── keepUnplaced, which is the scoping ──────────────────────────────────────
 *
 * `sites` is the list the viewer may SEE, not the whole register — every
 * analytics tab is handed it that way. So a row matching none of them is either
 * a site outside this viewer's grant or a name our register does not carry, and
 * the two are indistinguishable from here.
 *
 * For someone who can see every site, it is the second: keep it, or a finding
 * whose warehouse spelling differs from ours vanishes from the totals. For
 * anyone else it is most likely the first, and showing them another region's
 * findings because the join happened to fail is the scoping mistake this whole
 * page is most exposed to. Same rule, same parameter name, as resolveIncidents.
 */
export function resolveOdinRows(rows = [], sites = [], { keepUnplaced = true } = {}) {
  const byId = new Map()
  const byName = new Map()
  // A third index, on the name with every non-alphanumeric character removed,
  // so "Cult - Pitampura", "Cult Pitampura" and "cult(pitampura)" are one site.
  // Punctuation and spacing are where a warehouse name and a register name
  // usually differ, and losing an audit to a hyphen is not a data problem
  // anybody can be asked to go and fix.
  //
  // A loose key claimed by TWO different sites is set to null and matches
  // nothing thereafter. Guessing between them would attribute an audit to the
  // wrong centre — silently, and in a register the reader trusts — which is
  // worse than leaving it unplaced and saying so.
  const byLoose = new Map()
  const byFold = new Map()
  for (const s of sites || []) {
    if (s?.id) byId.set(String(s.id), s)
    if (s?.name) {
      byName.set(normSiteName(s.name), s)
      const loose = looseKey(s.name)
      if (loose) {
        const seen = byLoose.get(loose)
        byLoose.set(loose, seen === undefined || seen?.id === s.id ? s : null)
      }
    }
    // ── The centre id, wherever the register keeps it ──────────────────────
    //
    // A warehouse identifies a site by ITS key — a centre service id, a store
    // code — and that is never this app's Firestore document id. Matching on
    // name alone is what makes a 700-centre estate lose a fifth of its rows to
    // spelling, so any of these fields is accepted as the join key, and an
    // admin can put the centre id in a site's attributes without a migration.
    for (const key of SITE_CODE_FIELDS) {
      const v = s?.[key] ?? s?.attributes?.[key]
      if (v !== undefined && v !== null && String(v).trim()) noteCentreId(String(v).trim(), s)
    }
  }

  // Exact stored spelling first, so a record that saved "NP-001" still finds
  // the site that holds "NP-001" even when another site is "np-001". A query
  // that matches no exact code falls through to a case-insensitive match, and
  // only when one site folds to it. Two sites that differ only by case are
  // not a guess.
  function noteCentreId(trimmed, site) {
    byId.set(trimmed, site)
    const folded = trimmed.toLowerCase()
    const prev = byFold.get(folded)
    if (prev === undefined) byFold.set(folded, site)
    else if (prev && prev.id !== site.id) byFold.set(folded, null)
  }

  return (rows || []).filter(Boolean).map((r) => {
    // Centre id first — an exact key beats a name every time — then the name
    // exactly, then the name ignoring punctuation and spacing.
    const rawId = r.siteId ? String(r.siteId).trim() : ''
    const exactId = rawId ? byId.get(rawId) : null
    // A case-only miss is not on byId. byFold is that site when exactly one
    // code folds to the query, and null when two sites do.
    const foldedId = rawId && !exactId ? byFold.get(rawId.toLowerCase()) || null : null
    const byCode = exactId || foldedId
    const exact = !byCode && r.site ? byName.get(normSiteName(r.site)) || null : null
    const loose = !byCode && !exact && r.site ? byLoose.get(looseKey(r.site)) || null : null
    const site = byCode || exact || loose
    return {
      // How the row found its site, so the tab can report the join rather than
      // leave "why is half my estate missing from the map" unanswerable.
      matchedBy: byCode ? 'id' : exact ? 'name' : loose ? 'name~' : '',
      ...r,
      site: r.site || site?.name || '',
      region: r.region || site?.region || '',
      entity: r.entity || site?.entity || '',
      lat: isNum(r.lat) ? r.lat : (isNum(site?.lat) ? site.lat : null),
      lng: isNum(r.lng) ? r.lng : (isNum(site?.lng) ? site.lng : null),
      // Where the coordinates came from, because "why is this site not on the
      // map" is the question this panel gets asked, and the answer is either
      // "your question has no lat/lng" or "that site has none in Sites".
      placedFrom: isNum(r.lat) && isNum(r.lng) ? 'query' : (isNum(site?.lat) && isNum(site?.lng) ? 'register' : ''),
      // Whether it matched a site THIS VIEWER may see, which is what the
      // filter below turns into scoping. Distinct from matchedSiteId, which
      // keeps whatever id the warehouse supplied so the map can still group by
      // it — an id we do not recognise is still an id.
      inScope: Boolean(site),
      matchedSiteId: site?.id || r.siteId || '',
    }
  }).filter((r) => keepUnplaced || r.inScope)
}
