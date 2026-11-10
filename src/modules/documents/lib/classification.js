// ─────────────────────────────────────────────────────────────────────────────
// Where a document applies: organization, region or site.
//
// The level is the answer to "is this mine?". A site manager opening the library
// needs the org-wide policies, the ones written for their region, and the ones
// written for their site — and needs the other forty sites' paperwork out of the
// way. That only works if the level is a fixed set of three, not a free-text tag
// that becomes "Site", "site-level" and "Kochi only" within a month.
//
// Two of the three levels name something, and the name is the whole point:
// "Region" without a region says a document is narrower than the organization
// without saying where, which nobody can act on. So a level that fails to name
// what it exists to name is treated as no classification at all — it lands with
// the documents that predate the field, because both need the same fix.
//
// ── Who writes this now ──────────────────────────────────────────────────────
//
// Nobody picks a level any more. The FOLDER a document is filed in decides it:
// tree.js turns a placement into a call to classificationFields below, so the
// browser and the security rule are written from the same act. What used to be
// a Level dropdown beside a Region dropdown — two controls that could disagree
// with each other and with where the document appeared — is now one.
//
// That is why this file no longer renders anything. It has one job: produce the
// fields the server's site rule reads (stack/policy.mjs siteBlocked). Levels and their storage still follow Objectives
// (level + the thing it scopes to) and the site fields every other module writes.
// ─────────────────────────────────────────────────────────────────────────────

export const ORG = 'org'
export const REGION = 'region'
export const SITE = 'site'
export const UNCLASSIFIED = 'unclassified'

const clean = (v) => String(v ?? '').trim()

/**
 * The level a document is effectively filed at.
 *
 * Absent, blank, unrecognised, or naming nothing → unclassified. Nothing here
 * guesses: a document with no level is never quietly promoted to org-wide just
 * because that is the level that would hide the problem.
 */
export function levelOf(doc) {
  switch (clean(doc?.level)) {
    case ORG: return ORG
    case REGION: return clean(doc?.region) ? REGION : UNCLASSIFIED
    case SITE: return clean(doc?.siteId) ? SITE : UNCLASSIFIED
    default: return UNCLASSIFIED
  }
}

/**
 * What `visibility` says to the security rule: 'all' is the whole org, 'site'
 * is only people whose access reaches the named site. It is deliberately a
 * separate field from `level` rather than derived from it in the rule, because
 * the client's query has to filter on exactly what the rule checks — and a
 * query cannot express "level is anything except site" over documents that
 * predate the field.
 */
export const VISIBLE_ALL = 'all'
export const VISIBLE_SITE = SITE

// Every key is written on every save, blank when unused. Firestore rejects
// undefined, and a document moved from Site to Organization that kept its
// siteId would apply everywhere and to one place at once — and, now, would
// still be locked to that site's staff.
const OPEN = {
  region: '',
  siteId: '',
  site: '',
  visibility: VISIBLE_ALL,
  siteRegion: '',
  siteEntity: '',
}

/**
 * The classification to persist.
 *
 * Only the fields the chosen level uses are filled — a document moved from Site
 * to Organization while keeping its siteId would go on turning up under that
 * site's filter, applying everywhere and to one place at once.
 *
 * The site's name is snapshotted next to its id so the document still says where
 * it applies once the site leaves the registry. Firestore rejects undefined, so
 * every field is written, blank when the level has no use for it.
 */
export function classificationFields(form = {}, sites = []) {
  const level = clean(form.level)
  if (level === REGION) return { ...OPEN, level, region: clean(form.region) }
  if (level === SITE) {
    const id = clean(form.siteId)
    const known = sites.find((s) => clean(s?.id) === id)
    // A site level that never resolved to a site names nothing, so it is not a
    // boundary either — it stays open rather than becoming a document only an
    // admin can ever see.
    if (!id) return { ...OPEN, level }
    return {
      level,
      region: '',
      siteId: id,
      site: clean(known?.name) || clean(form.site),
      visibility: VISIBLE_SITE,
      // Snapshotted so the document still says where it applies; the server's
      // site rule reads siteId (stack/policy.mjs siteBlocked).
      siteRegion: clean(known?.region) || clean(form.siteRegion),
      siteEntity: clean(known?.entity) || clean(form.siteEntity),
    }
  }
  return { ...OPEN, level: level === ORG ? ORG : '' }
}
