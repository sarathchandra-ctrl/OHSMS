// ─────────────────────────────────────────────────────────────────────────────
// Filling a site's external emergency contacts from its coordinates.
//
// Shared by the single-site "Map nearest" button and the bulk refresh in the
// site repository, so both write exactly the same thing.
//
// Two rules:
//
// 1. A contact's phone is that service's OWN published number, or it is blank.
//    An earlier version stored the national helpline (112) whenever
//    OpenStreetMap had no number, which produced rows like
//    "Nuffield Hospital · 112" — indistinguishable from a verified direct line.
//    Dialling 112 is correct advice, but it belongs on the poster as the
//    helpline, not as a hospital's number. Blank is honest; a wrong number is not.
//
// 2. A contact a person typed or edited is left alone. The lookup used to
//    overwrite it whenever the new search returned any phone, which is how a
//    hand-corrected hospital became whatever the map said this week. Rows this
//    lookup wrote (origin 'map', or the older "Nearest … via OpenStreetMap"
//    note) are the ones a recompute is allowed to replace.
// ─────────────────────────────────────────────────────────────────────────────
import { findNearestServices } from './nearby'
import { addContact, updateContact, deleteContact } from './firestore'

/** National/generic emergency lines — never a specific station's own number. */
const GENERIC = new Set([
  '112',
  '100',
  '101',
  '102',
  '108',
  '999',
  '911',
  '1091',
  '1098',
  '190',
  '191',
])

/** True if `phone` is a generic helpline rather than a service's direct line. */
export const isGenericHelpline = (phone) =>
  GENERIC.has(String(phone || '').replace(/[\s()+-]/g, ''))

/** A stored contact whose number is missing or is a generic helpline. */
export const needsRealNumber = (c) => !String(c?.phone || '').trim() || isGenericHelpline(c.phone)

/** The three roles the nearest-facility lookup fills. */
export const MAPPED_ROLES = ['Hospital', 'Police', 'Fire Brigade']

const externalFor = (site, contacts) =>
  (contacts || []).filter((c) => c.kind === 'external' && c.siteId === site.id)

/**
 * Does this site still need a lookup? True when it has no external contacts, or
 * any of them carries a missing/generic number.
 */
export function siteNeedsRefresh(site, contacts) {
  const mine = externalFor(site, contacts)
  return mine.length === 0 || mine.some(needsRealNumber)
}

/**
 * Note the previous lookup wrote. A person who typed "call the hospital on
 * MG Road" does not match this — the "via <source>" clause is the tell.
 */
const LEGACY_MAP_NOTE =
  /^Nearest (hospital|police|fire brigade)\b[\s\S]*\bvia (OpenStreetMap|Google Places|Google|Nominatim)\b/i

/**
 * 'map' — written by this lookup (or by the older one, recognised by its note).
 * 'manual' — a person saved it. An explicit origin wins over the note, so
 * editing a mapped row and saving it protects the correction.
 */
export function contactOrigin(c) {
  if (c?.origin === 'manual') return 'manual'
  if (c?.origin === 'map') return 'map'
  if (LEGACY_MAP_NOTE.test(String(c?.notes || ''))) return 'map'
  return 'manual'
}

/**
 * True when a recompute would change something: a mapped role is missing, or
 * a previous lookup still owns that role. A site whose Hospital, Police and
 * Fire Brigade were all entered by hand does not need one.
 */
export function siteNeedsRecompute(site, contacts) {
  const mine = externalFor(site, contacts)
  return MAPPED_ROLES.some((role) => {
    const rows = mine.filter((c) => c.role === role)
    if (!rows.length) return true
    return rows.some((c) => contactOrigin(c) === 'map')
  })
}

const SOURCE_LABEL = {
  google: 'Google Places',
  nominatim: 'OpenStreetMap (Nominatim fallback — confirm)',
  overpass: 'OpenStreetMap',
}

export function noteFor(r) {
  const via = SOURCE_LABEL[r.source] || 'OpenStreetMap'
  const bits = [`Nearest ${r.role.toLowerCase()} (~${r.distanceKm} km straight-line) via ${via}`]
  if (r.limited) bits.push('specialty or non-emergency unit — confirm it can take the call')
  if (r.fallback)
    bits.push(`no ${r.role.toLowerCase()} tagged within ${r.searchedKm} km — closest similar place`)
  if (!r.phone) bits.push('no published number — confirm it locally and enter it manually')
  return bits.join(' · ')
}

export function contactPayload(site, r) {
  return {
    kind: 'external',
    role: r.role,
    name: r.name,
    phone: r.phone, // '' when the map has none — deliberately not a helpline
    altPhone: '',
    email: '',
    employeeUid: '',
    department: '',
    region: site.region || '',
    entity: site.entity || '',
    siteId: site.id,
    site: site.name,
    address: r.address || '',
    distanceKm: r.distanceKm,
    origin: 'map',
    notes: noteFor(r),
  }
}

/**
 * What to do with one role. A manual contact is never overwritten unless
 * `replaceManual` is set. Mapped duplicates of a role a person already owns
 * are retired so the poster does not keep the old, wrong station beside the
 * one they entered.
 */
export function planContactWrite(rows, { replaceManual = false } = {}) {
  const manual = rows.filter((c) => contactOrigin(c) === 'manual')
  const mapped = rows.filter((c) => contactOrigin(c) === 'map')
  if (manual.length && !replaceManual) {
    return { action: 'skip', id: null, retireIds: mapped.map((c) => c.id).filter(Boolean) }
  }
  if (replaceManual && manual.length) {
    return {
      action: 'update',
      id: manual[0].id,
      retireIds: [...manual.slice(1), ...mapped].map((c) => c.id).filter(Boolean),
    }
  }
  if (mapped.length) {
    return {
      action: 'update',
      id: mapped[0].id,
      retireIds: mapped
        .slice(1)
        .map((c) => c.id)
        .filter(Boolean),
    }
  }
  return { action: 'add', id: null, retireIds: [] }
}

/**
 * Pure plan for one site. `siteExternalContacts` is that site's external rows.
 */
export function planAutofill(site, siteExternalContacts, found, opts = {}) {
  const actions = []
  let skipped = 0
  for (const r of found || []) {
    const rows = (siteExternalContacts || []).filter((c) => c.role === r.role)
    const decision = planContactWrite(rows, opts)
    if (decision.action === 'skip') skipped += 1
    actions.push({
      ...decision,
      role: r.role,
      payload: decision.action === 'skip' ? null : contactPayload(site, r),
    })
  }
  return { actions, skipped }
}

/**
 * Look up the nearest services for one site and upsert its external contacts.
 * Existing mapped rows for the same role are updated in place. Contacts a
 * person entered are left as they are (and a stale mapped duplicate of that
 * role is removed). Throws if the map lookup itself failed, so the caller
 * can report that site as failed rather than silently leaving stale data.
 */
export async function autofillSite(site, contacts, actor, opts = {}) {
  const found = await findNearestServices(site.lat, site.lng)
  const mine = externalFor(site, contacts)
  const plan = planAutofill(site, mine, found, opts)

  let added = 0
  let updated = 0
  let retired = 0
  for (const step of plan.actions) {
    if (step.action === 'add') {
      await addContact(step.payload, actor)
      added += 1
    } else if (step.action === 'update') {
      await updateContact(step.id, step.payload, actor)
      updated += 1
    }
    for (const id of step.retireIds) {
      const row = mine.find((c) => c.id === id)
      await deleteContact(id, actor, `${step.role} · ${row?.name || id}`)
      retired += 1
    }
  }

  const written = plan.actions.filter((s) => s.action !== 'skip')
  return {
    added,
    updated,
    retired,
    skipped: plan.skipped,
    withNumber: written.filter((s) => s.payload?.phone).length,
    withoutNumber: written.filter((s) => s.payload && !s.payload.phone).length,
    results: found,
    plan,
  }
}

/**
 * Refresh many sites, one after another.
 *
 * Deliberately sequential with a pause between sites: the public Overpass
 * mirrors rate-limit aggressively and firing 59 parallel queries gets the whole
 * run throttled (HTTP 429). Slower and complete beats fast and half-empty.
 *
 * `onProgress({ done, total, site, status, detail })` is called per site so the
 * caller can render a live log. Failures never abort the run; `shouldStop()`
 * lets the caller stop it between sites, leaving already-updated sites saved.
 */
export async function refreshSites(
  sites,
  contacts,
  actor,
  onProgress,
  { pauseMs = 1200, shouldStop, replaceManual = false } = {}
) {
  const summary = {
    ok: 0,
    failed: 0,
    added: 0,
    updated: 0,
    retired: 0,
    skipped: 0,
    withNumber: 0,
    withoutNumber: 0,
    failures: [],
    stopped: false,
  }

  for (let i = 0; i < sites.length; i += 1) {
    if (shouldStop?.()) {
      summary.stopped = true
      break
    }
    const site = sites[i]
    onProgress?.({ done: i, total: sites.length, site, status: 'running' })
    try {
      const r = await autofillSite(site, contacts, actor, { replaceManual })
      summary.ok += 1
      summary.added += r.added
      summary.updated += r.updated
      summary.retired += r.retired
      summary.skipped += r.skipped
      summary.withNumber += r.withNumber
      summary.withoutNumber += r.withoutNumber
      const kept = r.skipped ? `, kept ${r.skipped} entered by hand` : ''
      onProgress?.({
        done: i + 1,
        total: sites.length,
        site,
        status: 'done',
        detail: `${r.withNumber} with a number, ${r.withoutNumber} without${kept}`,
      })
    } catch (err) {
      summary.failed += 1
      summary.failures.push({ site: site.name, message: err?.message || 'Lookup failed' })
      onProgress?.({
        done: i + 1,
        total: sites.length,
        site,
        status: 'failed',
        detail: err?.message || 'Lookup failed',
      })
    }
    if (i < sites.length - 1) await new Promise((r) => setTimeout(r, pauseMs))
  }

  return summary
}
