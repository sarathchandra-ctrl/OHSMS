// ─────────────────────────────────────────────────────────────────────────────
// Giving equipment records the siteId they were created without.
//
// Extinguishers, AEDs and FAS devices predate sites being first-class. They
// arrived from a standalone system that knew a site only as a free-text
// "Center Name", so a large part of the estate carries a centre name printed on
// a physical label and no siteId at all. Every join that goes through the site
// registry — the display fill-in in src/modules/fire/lib/siteResolve.js, the
// analytics roll-ups, the site filters — sees nothing for those records.
//
// Being precise about what this does NOT do, because the name invites the wrong
// expectation: no firestore.rules path reads a siteId on any of these three
// collections today. reachesSite() guards /documents and nothing else. So this
// grants nobody access and hides nothing. It repairs the joins, and it is the
// prerequisite for scoping equipment by site at all — which is exactly why a
// wrong link here is expensive. A guess made today becomes an access decision
// the day that scoping lands, and nobody re-checks a backfill that already
// reported success.
//
// Three rules follow from that, and they are the whole module:
//
//   1. siteId and nothing else. Never a name, in either direction. The centre
//      name on an extinguisher is stencilled on the extinguisher; a stored
//      string must not change because a link was missing. This deliberately
//      diverges from linkKindToSites (src/modules/fire/lib/firestore.js:1040),
//      which rewrites centerName from the matched site. That behaviour is
//      shipped, pinned by a test, and is not being changed from here — a
//      backfill is simply not the place to rename anything.
//
//   2. Two sites that normalise to the same name make EVERY record carrying
//      that name ambiguous. The app's indexSites (siteLink.js:111-120) is
//      first-writer-wins, so "Cult Gym X" and "Cult X" collapse to one key and
//      one of them wins by document order — a coin flip presented as a match.
//      Filing equipment at the wrong site is the exact failure this job exists
//      to fix, and doing it silently is worse than leaving the record unlinked.
//
//   3. A record that already has a siteId naming a different site than its text
//      implies is reported, never overwritten. Somebody may have linked it by
//      hand, correctly, and the stale text is the wrong half. This job cannot
//      tell which half is stale, so it does not get to pick. Same discipline as
//      the `foreign` bucket in qrMirrors.js, for the same reason.
//
// Pure planning only. Nothing here reads or writes Firestore; index.js does
// that with what these functions decide, which is what makes the decision
// testable without a database, as qrMirrors.js does it.
//
// Not to be confused with src/modules/fire/lib/siteLink.js (singular), the
// app-side linker this borrows its string handling from.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collections whose documents carry a free-text centerName and a siteId.
 *
 * `signages` is deliberately absent although it carries a centerName too:
 * cleanSignage (src/modules/fire/lib/firestore.js:850) never copies siteId, so
 * the Signages page collects one (Signages.jsx:25,242) and the write drops it
 * on the floor. Linking those would create a field only this job believes in —
 * no writer maintains it and no reader consults it.
 */
export const LINKABLE_COLLECTIONS = ['extinguishers', 'aeds', 'fas']

// ── Normalisation ────────────────────────────────────────────────────────────
// Copied VERBATIM from src/modules/fire/lib/siteLink.js:68-71. functions/
// deploys as its own package and cannot import from src/, so this is a copy —
// the same seam, and the same duty to stay in step, as MEDICAL_FIELDS in
// incidentMedical.js.
//
// These three are the half of the app's linker that has been validated against
// real data: the Cult site master against the Fire Marshal export, bracketed
// locality suffixes, en-dashes, casing and all. What this module replaces is
// the DECISION layer above them. The string handling is not up for reinvention.

const base = (s) => String(s ?? '').trim().toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ')
const alnum = (s) => base(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
// "Gym" is noise: the site registry includes it, the equipment records often don't.
const core = (s) => alnum(s).split(' ').filter((w) => w !== 'gym').join(' ')

/**
 * Key functions by tier name. `exact` is identity on purpose — it is the one
 * tier that requires the registry's name character for character, so it is
 * worth reporting separately from a match that survived normalisation.
 */
const NORMALISE = {
  exact: (s) => String(s ?? ''),
  base,
  alnum,
  core,
}

/**
 * The decision order, loosest last.
 *
 * The FIRST tier to produce any candidate at all decides the outcome —
 * including deciding the outcome is "ambiguous". Falling through a tier that
 * produced two candidates would be worse than stopping there: it would keep
 * loosening until some rule finally produced a single answer, and the looser
 * the rule, the less that answer is worth. Ambiguity at a tight tier is a
 * stronger signal than agreement at a loose one.
 *
 * `override` sits last, where the app's resolveSite (siteLink.js:131) puts it
 * first. Deliberate: the table below was written against one customer's site
 * master, so a site the org actually has, matched on its own name, is better
 * evidence than a hand-written mapping made from someone else's data. The table
 * only gets to speak when nothing else did.
 */
export const MATCH_TIERS = ['exact', 'base', 'alnum', 'core', 'override']

/**
 * Equipment center name → canonical site name, for the decisions normalisation
 * cannot make because they need locality or brand knowledge.
 *
 * MUST stay in step with SITE_NAME_OVERRIDES in src/modules/fire/lib/siteLink.js
 * — same copy-across-the-package-boundary duty as the normalisers above.
 *
 * Every row was confirmed against the site master's Locality column, never
 * guessed from string similarity: similarity paired "G8 Fitness Studio -
 * Sainikpuri" with "Stark Fitness Studio (Sainikpuri)" — same locality,
 * different business — and "Cult Suchitra Hybrid" with a Somajiguda site when a
 * Suchitra Road site exists. That is why this is a table and not a threshold.
 *
 * Known limit, and the reason planSiteLinks takes an `overrides` option: this
 * table is GLOBAL and these are one tenant's names. Another org that genuinely
 * runs a site called "Iron Fist" would have its "Iron Fist Fitness" equipment
 * mapped there by a decision made about somebody else's data. Running a tenant
 * whose names were not confirmed here is a reason to pass `{ overrides: {} }`
 * and take the normalisation tiers alone.
 */
export const SITE_NAME_OVERRIDES = {
  // Locality or brand disambiguation
  'Cult Suchitra Hybrid': 'Cult Gym Suchitra Road (Suchitra)',
  'Elevate fitness Chandanagar': 'Elevate Fitness Studio',
  'Fitness Freaks - S R Nagar': 'Fitness Freaks',
  'Gym Point Chandanagar': 'Gym Point The Fitness Studio (Chandanagar)',
  'Gym Point Gopanapalle': 'Gympoint (T-360 Fitness)',
  'Millenium Fitness (Punjagutta)': 'Millenium Fitness Club',
  'Pilate Studio Banjara Hills Rd-2': 'Pilates Circle - Banjara Hills',
  'Raptor Fitness (Addaguta)': 'Raptor Fitness (Addagutta)',
  'G8 Fitness Studio - Sainikpuri': 'G8 Fitness',
  'Stark fitness studio (Hyder Nagar)': 'Stark Fitness Studio (Hydernagar)',
  'Sunrise Miyapur': 'Cult Miyapur Sunrise Swimming',
  'V Fitness (Miyapur)': 'V Fitness Center (Nizampet)',
  'Play Time Sport': 'Fitso Kondapur Playtime Sports',
  'Play time Swimming': 'Fitso Kondapur Playtime',
  // Typos in the source data
  'Strak Fitness Studio - Sainikpuri': 'Stark Fitness Studio (Sainikpuri)',
  'F7 by Prasad Konda (Raisal Bazar)': 'F7 By Prasad konda (Risala Bazar)',
  'Five Hive Fitness (Kukatpally)': 'Five The Fitness Hive (Kukatpally)',
  // Naming-convention differences
  'Cult Store - Irrum Manzil': 'Cult EBO @ Irrum Manzil',
  'Madhapur Pearl': 'Fitso Madhapur Pearl',
  'F99 Pragathi Nagar': 'F99 Fit (Pragathi Nagar)',
  'CULT – Botanical Garden': 'Cult Gym Botanical Garden Rd',
  'Cult Botanical Garden Camelot Layout': 'Cult Gym Camelot layout, Botanical Garden',
  'Stallion Xtreme Fitness (BHEL)': 'Stallion Fitness (BHEL)',
  'Stallion Xtreme Suchitra': 'Stallion Xtreme Fitness (Suchitra)',
  // Site names carry a locality suffix the equipment records omit
  'Cult Gym Beeramguda': 'Cult gym Beeramguda - Hybrid (Beeramguda)',
  'Cult Gym Nizampet - Hybrid': 'Cult Gym Nizampet - Hybrid (Nizampet)',
  'Cult Somajiguda': 'Cult Gym Somajiguda - Hybrid',
  'Cult Gym Moosapet': 'Cult Gym Moosapet (Moosapet)',
  'Cult Gym Khajaguda': 'Cult Gym Khajaguda (Khajaguda)',
  'F Square Fitness (Kondapur)': 'F Square Fitness',
  'Pran Fitness Kondapur': 'Pran Fitness',
  'Conquest Fitness (Kondapur)': 'Conquest Fitness',
  'Iron Fist Fitness': 'Iron Fist',
  'Absolute Fitness Studio Kukatpally': 'Absolute Fitness Studio',
}

/**
 * Index sites by every tier, keeping EVERY site under each key.
 *
 * The app's indexSites (siteLink.js:111-120) keeps the first site to claim a
 * key and drops the rest, and its test pins that. On a screen offering a human
 * a choice that is a cosmetic flaw. For an unattended write it is the whole
 * problem: one of two real sites wins on document order and equipment is filed
 * there with no trace that a second candidate existed.
 *
 * Keyed per tier rather than into one shared map, which is what makes counting
 * candidates meaningful — a site's `base` key must not silently answer another
 * record's `core` lookup and look like a tight match. Nothing is lost by the
 * separation: normalisation only ever loosens, so anything the shared map
 * matched across tiers still meets at `core`.
 *
 * Sites with no name are skipped. They are already invisible to every reader in
 * the app: subscribeSites orders by name (src/shared/org/orgData.js:271) and
 * Firestore drops documents missing the ordered field, so a nameless site would
 * not be in this list to begin with.
 */
export function indexSites(sites = []) {
  const index = new Map(Object.keys(NORMALISE).map((how) => [how, new Map()]))

  for (const s of sites || []) {
    if (!s || !s.id) continue
    for (const [how, keyOf] of Object.entries(NORMALISE)) {
      const key = keyOf(s.name)
      if (!key) continue
      const bucket = index.get(how)
      const found = bucket.get(key)
      if (!found) bucket.set(key, [s])
      // The same site listed twice is not two candidates.
      else if (!found.some((x) => x.id === s.id)) found.push(s)
    }
  }

  return index
}

/**
 * Resolve one centre name against the site registry.
 *
 * Returns one of:
 *   { status: 'matched',   site, how }  exactly one candidate at tier `how`
 *   { status: 'ambiguous', sites, how } two or more — reported, never chosen
 *   { status: 'unmatched' }             no tier produced a candidate
 *   { status: 'noName' }                nothing to match on
 *
 * There is no fifth answer and no best guess. suggestSite in the app exists to
 * offer a person a choice on upload; there is no person here.
 */
export function resolveSite(centerName, sites = [], { index = indexSites(sites), overrides = SITE_NAME_OVERRIDES } = {}) {
  const raw = String(centerName ?? '').trim()
  if (!raw) return { status: 'noName' }

  for (const how of MATCH_TIERS) {
    let name = raw
    let lookup = how

    if (how === 'override') {
      // hasOwnProperty, not a bare read: a centre name of "constructor" or
      // "__proto__" would otherwise pull a value off Object.prototype and be
      // treated as a mapping somebody wrote.
      if (!Object.prototype.hasOwnProperty.call(overrides || {}, raw)) continue
      name = overrides[raw]
      if (typeof name !== 'string') continue
      // The table names a site; finding it is still a lookup, and one the org
      // can fail — the table is global and this org may not have that site.
      lookup = 'base'
    }

    const key = NORMALISE[lookup](name)
    if (!key) continue

    const hits = index.get(lookup).get(key)
    if (!hits) continue
    if (hits.length === 1) return { status: 'matched', site: hits[0], how }
    return { status: 'ambiguous', sites: hits, how }
  }

  return { status: 'unmatched' }
}

/**
 * Decide what linking would change, without writing anything.
 *
 * @param equipment [{ collection, id, centerName, siteId, deletedAt }]
 * @param sites     [{ id, name }] the site registry for ONE org
 *
 * Returns every record in exactly one bucket:
 *   writes        [{ collection, id, siteId, matchedName }] confident matches
 *   ambiguous     name resolves to more than one site — never picked between
 *   conflicting   already linked, and to a different site than the name implies
 *   unmatched     name resolves to nothing, and no link to fall back on
 *   noName        no centre name at all; unmatchable here, needs another route
 *   alreadyLinked count — nothing to do
 *   deleted       count — soft-deleted, skipped
 *
 * `matchedName` is the site's registry name and is for the dry-run report only:
 * it is what makes "e1 → s7" readable by a human before anyone types yes twice.
 * It is NOT part of the patch. The patch is `{ siteId }`, and the caller has
 * nothing else here to write even by accident.
 *
 * Idempotent by construction: a record whose siteId already equals what the
 * name resolves to is counted and skipped, so a second run — by someone unsure
 * whether the first took — writes nothing.
 */
export function planSiteLinks(equipment = [], sites = [], { overrides = SITE_NAME_OVERRIDES } = {}) {
  const index = indexSites(sites)
  const writes = []
  const ambiguous = []
  const conflicting = []
  const unmatched = []
  const noName = []
  let alreadyLinked = 0
  let deleted = 0
  const seen = new Set()

  for (const record of equipment || []) {
    if (!record || !record.id) continue

    if (record.deletedAt) { deleted += 1; continue }

    // One document named twice would put two writes for the same path into one
    // batch, which Firestore rejects outright — failing the whole run over a
    // duplicate in the caller's query rather than over anything wrong here.
    const path = `${record.collection}/${record.id}`
    if (seen.has(path)) continue
    seen.add(path)

    const centerName = String(record.centerName ?? '').trim()
    const currentSiteId = String(record.siteId ?? '').trim()
    const row = { collection: record.collection, id: record.id, centerName }
    const hit = resolveSite(centerName, sites, { index, overrides })

    // An existing link is evidence in its own right, and better evidence than
    // free text: it was written by the app or by a person, and the text is what
    // is known to be stale. So anywhere the name fails to produce a single
    // answer, a record that already carries a siteId is left exactly as it is
    // rather than being reported as a problem it is not.
    if (hit.status === 'noName') {
      if (currentSiteId) { alreadyLinked += 1; continue }
      noName.push(row)
      continue
    }

    if (hit.status === 'unmatched') {
      if (currentSiteId) { alreadyLinked += 1; continue }
      unmatched.push(row)
      continue
    }

    if (hit.status === 'ambiguous') {
      const siteIds = hit.sites.map((s) => s.id)
      // Already pointing at one of the candidates: somebody has already made
      // the choice this job refuses to make. Re-reporting it every run would
      // train the reader to skip the bucket that matters most.
      if (currentSiteId && siteIds.includes(currentSiteId)) { alreadyLinked += 1; continue }
      ambiguous.push({
        ...row,
        currentSiteId: currentSiteId || null,
        siteIds,
        siteNames: hit.sites.map((s) => s.name),
        how: hit.how,
      })
      continue
    }

    if (!currentSiteId) {
      writes.push({ collection: record.collection, id: record.id, siteId: hit.site.id, matchedName: hit.site.name })
      continue
    }

    if (currentSiteId === hit.site.id) { alreadyLinked += 1; continue }

    conflicting.push({
      ...row,
      currentSiteId,
      resolvedSiteId: hit.site.id,
      resolvedName: hit.site.name,
      how: hit.how,
    })
  }

  return {
    writes,
    ambiguous,
    conflicting,
    unmatched,
    // The names, not the rows: a few hundred unmatched records collapse to a
    // couple of dozen centre names, and a name is what a person can actually
    // go and fix.
    unmatchedNames: [...new Set(unmatched.map((u) => u.centerName))].sort(),
    noName,
    alreadyLinked,
    deleted,
  }
}
