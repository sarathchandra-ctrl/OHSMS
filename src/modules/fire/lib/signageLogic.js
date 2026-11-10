import { FLOOR_SIGNAGE_TYPES, SIGNAGE_TYPES, SIGNAGE_STATUSES, SIGNAGE_STATUS_NOT_SET } from './constants'

// Scoring rules for safety signage, shared by the Signage matrix (the register)
// and the Signage Compliance dashboard so both read a site the same way. Keeping
// them in one place is the point: a site that shows "covered" on the matrix and
// "gap" on the dashboard is worse than having no dashboard at all.

// Every fire extinguisher should have a "Fire Extinguisher Sign", so this type
// is scored against the number of extinguishers at the site (from the
// Repository) rather than mere presence.
export const EXT_SIGN_TYPE = 'Fire Extinguisher Sign'

// ── Status, compliance, photos, and the "Deployed" requirement ───────────────

/** The status to DISPLAY for a record: its own, or "Not set" for older records. */
export const signageStatus = (s) => (SIGNAGE_STATUSES.includes(s?.status) ? s.status : SIGNAGE_STATUS_NOT_SET)

/**
 * Is this record compliant? Status alone decides: Deployed is compliant; Planned,
 * Removed and Not set are not. (The old per-record "condition" field no longer
 * takes part — stored values are simply ignored.)
 */
export const isSignageCompliant = (s) => s?.status === 'Deployed'

const isPointer = (p) => Boolean(p && typeof p === 'object' && !Array.isArray(p) && (p.path || p.url || p.dataUrl))
const isDraft = (p) => typeof p === 'string' && p.startsWith('data:')

/**
 * The photos of a record, as a list. An entry is either a stored pointer
 * (`{ path | url | dataUrl, … }`) or, in the edit form, a freshly picked image as
 * a `data:` URL string that is uploaded on save.
 *
 * `photos` is the field. Records saved before it existed carry a single `photo`
 * pointer, which is read as one entry — until the record is next saved, which
 * writes `photos` and drops `photo`. Once `photos` is an array it is the whole
 * truth (an emptied array means "no photos", not "fall back to the legacy one").
 */
export function signagePhotos(rec) {
  if (!rec) return []
  if (Array.isArray(rec.photos)) return rec.photos.filter((p) => isPointer(p) || isDraft(p))
  return isPointer(rec.photo) ? [rec.photo] : []
}

export const signagePhotoCount = (rec) => signagePhotos(rec).length

/** Does this record have at least one photo (stored, or picked and waiting to upload)? */
export const hasSignagePhoto = (rec) => signagePhotoCount(rec) > 0

const positiveInt = (v) => {
  const n = Math.ceil(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * How many photos a record is expected to have, and what each one stands for.
 *  - FERP Signage: one per floor covered (all floors → the number of floors);
 *  - Fire Extinguisher Sign: one per extinguisher, i.e. the `quantity`;
 *  - anything else: one.
 * Never less than 1. Informational: it is not enforced on save or by the server.
 * → { count, per: 'floor' | 'extinguisher' | null }
 */
export function requiredSignagePhotos(rec) {
  if (rec?.type === EXT_SIGN_TYPE) return { count: Math.max(1, positiveInt(rec.quantity)), per: 'extinguisher' }
  if (rec && isFerp(rec.type)) {
    // Same clamp the save applies: covered floors can't exceed the total.
    const total = positiveInt(rec.totalFloors)
    const floors = rec.allFloors ? total : total ? Math.min(positiveInt(rec.floorsCovered), total) : positiveInt(rec.floorsCovered)
    return { count: Math.max(1, positiveInt(floors)), per: 'floor' }
  }
  return { count: 1, per: null }
}

export const DEPLOYED_PHOTO_ERROR = 'Add a photo before marking as deployed'
export const DEPLOYED_DATE_ERROR = 'Enter the last checked date'

/**
 * Photos still expected beyond what has been uploaded: `{ have, need, missing, per }`.
 * INFORMATION ONLY — it never blocks a save. Deployed needs just one photo (see
 * deployedRequirementErrors); the required count is what the form counter and the
 * Signage Compliance board compare the uploaded number against.
 */
export function signagePhotoProgress(rec) {
  const { count, per } = requiredSignagePhotos(rec)
  const have = signagePhotoCount(rec)
  return { have, need: count, missing: Math.max(0, count - have), per }
}

/**
 * The soft warning for a record that has some photos but fewer than expected
 * ('' otherwise). Zero photos is not a soft case: for a Deployed record that is
 * the hard "Add a photo" error, and for any other status nothing is asked yet.
 */
export function photoShortfallMessage(rec) {
  const { have, need, missing, per } = signagePhotoProgress(rec)
  if (have === 0 || missing === 0) return ''
  return `${have} of ${need} photos added — ${per ? `one per ${per} is expected` : 'more expected'} (you can still save)`
}

/**
 * Photo totals for a set of records, over DEPLOYED records only — a Planned or
 * Removed sign is not expected to have its full set of photos yet.
 * → { required, uploaded, records, short: [{ record, have, need, per }] }
 * `uploaded` counts photos up to the required number per record, so a record with
 * surplus photos cannot hide another record's shortfall in the total.
 */
export function signagePhotoTotals(records = []) {
  const out = { required: 0, uploaded: 0, records: 0, short: [] }
  for (const r of records) {
    if (!isSignageCompliant(r)) continue
    const { have, need, missing, per } = signagePhotoProgress(r)
    out.records++
    out.required += need
    out.uploaded += Math.min(have, need)
    if (missing > 0) out.short.push({ record: r, have, need, per })
  }
  return out
}

const hasCheckedDate = (v) => typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Date.parse(v))

/**
 * What stops this record being saved as Deployed. → `{}` when nothing does,
 * otherwise `{ photo?: string, lastChecked?: string }` keyed by the field the
 * message belongs under.
 *
 * A sign is only Deployed when there is evidence of it: at least ONE photo AND a
 * date it was last checked. How many photos the sign ideally has (requiredSignagePhotos)
 * is reported, not enforced. The requirement applies
 * when the status is being SET to Deployed — a new record, or a change from
 * Planned / Removed / unset. A record that was already Deployed
 * (`prev.status === 'Deployed'`) is left alone: those were saved before this rule
 * and must stay loadable and editable for their other fields. The form applies
 * it; the server does not check it.
 *
 * @param record the form / payload about to be saved
 * @param prev   the stored record it replaces, or null/undefined for a new one
 */
export function deployedRequirementErrors(record, prev) {
  if (record?.status !== 'Deployed') return {}
  if (prev?.status === 'Deployed') return {}
  const errors = {}
  // One photo is the hard requirement; the fuller count (per floor / per
  // extinguisher) is shown as a warning and on the board, but does not block.
  if (!hasSignagePhoto(record)) errors.photo = DEPLOYED_PHOTO_ERROR
  if (!hasCheckedDate(record.lastChecked)) errors.lastChecked = DEPLOYED_DATE_ERROR
  return errors
}

export const isFerp = (type) => FLOOR_SIGNAGE_TYPES.includes(type)
// Floors that have FERP, given a record.
export const ferpCovered = (s) => (s.allFloors ? s.totalFloors || 0 : s.floorsCovered || 0)

/**
 * Site name → region / entity.
 *
 * The SITE REGISTER is asked first, because it is the authority on where a site
 * is: an asset record carries a copy of that, and a copy can be stale or blank.
 * Asset registers then fill in any site the register has never heard of, which
 * is how a site that exists only as somebody's imported spreadsheet row still
 * gets a region.
 *
 * ── Why every register, not just two ─────────────────────────────────────────
 *
 * This used to read extinguishers and signage alone, while the site LIST it was
 * being asked about came from five registers. A site known only to the AED or
 * fire-alarm register therefore resolved to no region and no entity — and the
 * filters compare against exactly this map, so picking any region dropped it.
 * It sat in the totals, contributed to the denominator, and could not be found.
 *
 * On real data that was twelve sites of a hundred and sixteen: present in every
 * unfiltered count, invisible the moment anybody touched a chip.
 *
 * @param field    'region' or 'entity'
 * @param sources  asset registers to read, in order of preference
 * @param registry the site register rows — {name, region, entity}
 */
export function siteAttributeMap(field, sources = [], registry = []) {
  const m = {}
  const take = (name, value) => {
    const site = String(name ?? '').trim()
    const v = String(value ?? '').trim()
    if (site && v && !m[site]) m[site] = v
  }

  // The authority first. Nothing below can overwrite it — `take` keeps the
  // first non-empty value it sees for a site.
  for (const s of registry || []) take(s?.name, s?.[field])
  for (const list of sources || []) for (const r of list || []) take(r?.centerName, r?.[field])

  return m
}

/** Site name → number of extinguishers, i.e. the required count of ext signs. */
export function extCountBySite(extinguishers = []) {
  const m = {}
  for (const e of extinguishers) {
    if (!e.centerName) continue
    m[e.centerName] = (m[e.centerName] || 0) + 1
  }
  return m
}

/**
 * Status of one (site, type) cell from the records already narrowed to it.
 * → { count, status: 'ok' | 'issue' | 'missing' | 'none', label? }
 * `required` is the site's extinguisher count, used only for EXT_SIGN_TYPE.
 *
 * Only Deployed records count as being in place (a Planned, Removed or Not-set
 * record is non-compliant):
 *   ok      every record is Deployed (for the extinguisher sign: and the count
 *           matches the fleet; for FERP: and every floor is covered)
 *   issue   partly there — some Deployed, some not / short of the fleet or floors
 *   missing records exist but none is Deployed
 *   none    nothing recorded
 */
export function signageCell(recs, type, required = 0) {
  const deployed = recs.filter(isSignageCompliant)
  const allDeployed = deployed.length === recs.length

  if (type === EXT_SIGN_TYPE) {
    const recorded = deployed.reduce((a, r) => a + (Number(r.quantity) || 1), 0)
    if (recs.length === 0 && required === 0) return { count: 0, status: 'none' }
    let status
    if (required === 0) status = recorded > 0 ? 'ok' : 'none'
    else if (recorded === 0) status = 'missing'
    else if (recorded < required) status = 'issue'
    else status = 'ok'
    if (status === 'ok' && !allDeployed) status = 'issue'
    const label = required > 0 ? `${recorded}/${required}` : (recorded > 0 ? String(recorded) : '—')
    return { count: recs.length, status, label }
  }

  if (recs.length === 0) return { count: 0, status: 'none' }
  // FERP shows floor coverage (covered / total) rather than a plain count.
  if (isFerp(type)) {
    const pool = deployed.length ? deployed : recs
    const rec = pool.reduce((a, b) => ((b.totalFloors || 0) > (a.totalFloors || 0) ? b : a), pool[0])
    const total = rec.totalFloors || 0
    const covered = deployed.length ? ferpCovered(rec) : 0
    let status = 'ok'
    if (deployed.length === 0 || covered === 0) status = 'missing'
    else if ((total > 0 && covered < total) || !allDeployed) status = 'issue'
    return { count: recs.length, status, label: total > 0 ? `${covered}/${total}` : '✓' }
  }
  if (deployed.length === 0) return { count: recs.length, status: 'missing' }
  if (!allDeployed) return { count: recs.length, status: 'issue' }
  return { count: recs.length, status: 'ok' }
}

/**
 * A type counts toward a site's coverage when its cell is satisfied. The
 * fire-extinguisher column requires a FULL match to the fleet (status 'ok'),
 * not mere presence.
 *
 * Everywhere else, covered means a DEPLOYED sign is there — 'ok', or 'issue'
 * where some records are Deployed and others are not. Deliberately not
 * `count > 0`: a Planned or Removed record is not a sign in place, and counting
 * it as covered would make a recorded absence read as compliance. The matrix
 * draws such a cell red; the coverage total must agree.
 */
export const isTypeCovered = (type, cell) =>
  type === EXT_SIGN_TYPE ? cell.status === 'ok' : cell.status === 'ok' || cell.status === 'issue'

/**
 * Compliance across a set of sites.
 *
 * A "cell" is one (site, signage type) pair — the unit the matrix scores and the
 * unit compliance is measured in, so a site with ten types and one gap reads as
 * 90 %, not as a plain pass/fail.
 *
 * → {
 *     sites, records, types,
 *     cells, covered, ok, issue, missing, notRecorded, compliance,
 *     fullyCompliant, sitesWithGaps,
 *     byType: [{ type, covered, gaps, issues, records, compliance }],
 *     bySite: [{ site, region, entity, covered, total, gaps, issues, records, compliance, missingTypes }],
 *     photos: { required, uploaded, records, short: [{ record, have, need, per }] },
 *     byStatus: { [status]: count } — Deployed / Planned / Removed / Not set,
 *   }
 */
/**
 * @param attrs { regionOf, entityOf } — the maps the CALLER already built for
 *        its filters. Passed in rather than rebuilt so the rows in this table
 *        and the chips that filter them cannot resolve a site differently;
 *        recomputing here from a narrower set of registers is exactly how they
 *        came to disagree. Omitted, it falls back to the two registers that
 *        carry these fields on nearly every record.
 */
export function signageSummary(sites, signages, extinguishers, types = SIGNAGE_TYPES, attrs = {}) {
  const regionOf = attrs.regionOf || siteAttributeMap('region', [extinguishers, signages])
  const entityOf = attrs.entityOf || siteAttributeMap('entity', [extinguishers, signages])
  const extCounts = extCountBySite(extinguishers)

  // Bucket the register by site once — signageSummary runs over every site ×
  // every type, and re-scanning the whole register in each cell is what makes a
  // 2 000-record fleet feel broken.
  const bySiteRecords = new Map(sites.map((s) => [s, []]))
  let records = 0
  const byStatus = {}
  for (const s of signages) {
    if (!bySiteRecords.has(s.centerName)) continue
    bySiteRecords.get(s.centerName).push(s)
    records++
    const st = signageStatus(s)
    byStatus[st] = (byStatus[st] || 0) + 1
  }

  const byType = types.map((t) => ({ type: t, covered: 0, gaps: 0, issues: 0, records: 0, compliance: 0, photosRequired: 0, photosUploaded: 0 }))
  const typeIndex = new Map(byType.map((r, i) => [r.type, i]))

  const totals = { ok: 0, issue: 0, missing: 0, notRecorded: 0 }
  const bySite = []

  for (const site of sites) {
    const siteRecs = bySiteRecords.get(site) || []
    const row = {
      site,
      region: regionOf[site] || '',
      entity: entityOf[site] || '',
      covered: 0,
      total: types.length,
      gaps: 0,
      issues: 0,
      records: siteRecs.length,
      compliance: 0,
      missingTypes: [],
      photosRequired: 0,
      photosUploaded: 0,
    }
    for (const type of types) {
      const recs = siteRecs.filter((r) => r.type === type)
      const cell = signageCell(recs, type, extCounts[site] || 0)
      const t = byType[typeIndex.get(type)]
      t.records += recs.length
      const pt = signagePhotoTotals(recs)
      t.photosRequired += pt.required
      t.photosUploaded += pt.uploaded
      row.photosRequired += pt.required
      row.photosUploaded += pt.uploaded
      totals[cell.status === 'none' ? 'notRecorded' : cell.status]++
      if (isTypeCovered(type, cell)) {
        row.covered++
        t.covered++
      } else {
        row.gaps++
        t.gaps++
        row.missingTypes.push(type)
      }
      if (cell.status === 'issue') {
        row.issues++
        t.issues++
      }
    }
    row.compliance = row.total ? Math.round((row.covered / row.total) * 100) : 0
    bySite.push(row)
  }

  const photos = signagePhotoTotals(signages.filter((r) => bySiteRecords.has(r.centerName) && types.includes(r.type)))
  const cells = sites.length * types.length
  const covered = bySite.reduce((n, r) => n + r.covered, 0)
  for (const t of byType) t.compliance = sites.length ? Math.round((t.covered / sites.length) * 100) : 0

  return {
    sites: sites.length,
    records,
    types: types.length,
    cells,
    covered,
    ...totals,
    compliance: cells ? Math.round((covered / cells) * 100) : 0,
    fullyCompliant: bySite.filter((r) => r.gaps === 0).length,
    sitesWithGaps: bySite.filter((r) => r.gaps > 0).length,
    byType: byType.sort((a, b) => a.compliance - b.compliance || a.type.localeCompare(b.type)),
    bySite: bySite.sort((a, b) => b.gaps - a.gaps || b.issues - a.issues || a.site.localeCompare(b.site)),
    byStatus,
    // Deployed records' photos: required vs uploaded, and who is short.
    photos,
  }
}
