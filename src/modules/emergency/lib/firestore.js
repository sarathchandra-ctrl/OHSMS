// ─────────────────────────────────────────────────────────────────────────────
// Emergency Response (FERP) data layer — the emergency contact directory.
//   organizations/{orgId}/erpContacts
// External contacts (Police, Ambulance, Fire Brigade, …) and internal
// escalation contacts (CM, CLM, Safety L1/L2, Legal, HR), scoped to sites via
// the org's granularity model.
// ─────────────────────────────────────────────────────────────────────────────
import {
  addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query,
  serverTimestamp, setDoc, updateDoc, writeBatch,
  limit,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { logAudit, COLLECTION_READ_CAP } from '../../../shared/org/orgData'
import { todayISO, addDaysISO } from '../../../shared/lib/dates'
import { ERP_ROLE_KEYS } from '../../../shared/org/erpRoles'
import { reserveDocId } from '../../../shared/docId/reserve'

const col = () => collection(db, 'erpContacts')
const ref = (id) => doc(db, 'erpContacts', id)

// Note: the Safety & Security helpline is org-wide (Org Settings → General),
// not a per-site contact — it prints on every site's SOS poster.
export const EXTERNAL_ROLES = [
  'Police', 'Ambulance', 'Fire Brigade', 'Hospital', 'Electricity Board',
  'Gas Emergency', 'Pollution Control', 'Other',
]
// Role KEYS are fixed (stored on contacts, plans and drills); each org chooses
// the labels it sees, in Org Settings → General. See shared/org/erpRoles.
export const INTERNAL_ROLES = ERP_ROLE_KEYS

export function subscribeContacts(cb) {
  const q = query(col(), orderBy('role'), limit(COLLECTION_READ_CAP))
  return onSnapshot(q, (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))), () => cb([]))
}

const clean = (data) => ({
  kind: data.kind === 'internal' ? 'internal' : 'external',
  role: (data.role || '').trim() || 'Other',
  name: (data.name || '').trim(),
  phone: (data.phone || '').trim(),
  altPhone: (data.altPhone || '').trim(),
  email: (data.email || '').trim(),
  employeeUid: data.employeeUid || '',
  department: data.department || '',
  region: data.region || '',
  entity: data.entity || '',
  siteId: data.siteId || '',
  site: data.site || '',
  notes: (data.notes || '').trim(),
  // Where the nearest-facility lookup puts the address and straight-line
  // distance. `origin` is 'map' for a row this lookup wrote and 'manual' for
  // one a person saved, so a recompute can tell them apart. Old rows have
  // neither; the lookup note is what identifies those.
  address: (data.address || '').trim(),
  distanceKm: distanceOrNull(data.distanceKm),
  origin: data.origin === 'manual' ? 'manual' : data.origin === 'map' ? 'map' : '',
})

// '' is what an untouched form field holds. Number('') is 0, which would
// store "the facility is at the site" for a contact that was never measured.
function distanceOrNull(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null
}

export async function addContact(data, actor) {
  const r = await addDoc(col(), { ...clean(data), createdAt: serverTimestamp(), createdBy: actor?.uid || null })
  await logAudit(actor, 'erp.contact_create', {
    module: 'emergency', target: 'contact', targetId: r.id, targetLabel: `${data.role} · ${data.name}`,
    summary: `Added ${data.kind} emergency contact "${data.name}" (${data.role})`,
  })
  return r.id
}

export async function updateContact(id, data, actor) {
  await updateDoc(ref(id), { ...clean(data), updatedAt: serverTimestamp() })
  await logAudit(actor, 'erp.contact_update', {
    module: 'emergency', target: 'contact', targetId: id, targetLabel: `${data.role} · ${data.name}`,
    summary: `Updated emergency contact "${data.name}"`,
  })
}

export async function deleteContact(id, actor, label) {
  await deleteDoc(ref(id))
  await logAudit(actor, 'erp.contact_delete', {
    module: 'emergency', target: 'contact', targetId: id, targetLabel: label,
    summary: `Removed emergency contact "${label}"`,
  })
}

// ── Evacuation layouts (one doc per site, keyed by siteId) ───────────────────
// Kept out of the site registry docs so the app-wide sites listener stays light.
const layoutRef = (siteId) => doc(db, 'erpLayouts', siteId)
const layoutCol = () => collection(db, 'erpLayouts')

export function subscribeLayouts(cb) {
  // One layout per site, so this is bounded by the site registry rather than
  // by activity — but bounded by something the customer controls is not the
  // same as bounded.
  return onSnapshot(
    query(layoutCol(), limit(COLLECTION_READ_CAP)),
    (s) => cb(Object.fromEntries(s.docs.map((d) => [d.id, d.data()]))),
    () => cb({})
  )
}

/**
 * A site's FERP layout doc holds an ordered list of floor plans:
 *   { siteId, siteName, floors: [{ id, label, dataUrl, fileName }] }
 * Older single-image docs (dataUrl at the top level) are read as one floor.
 */
export function floorsOf(layout) {
  if (!layout) return []
  if (Array.isArray(layout.floors) && layout.floors.length) return layout.floors
  return layout.dataUrl
    ? [{ id: 'legacy', label: 'Ground floor', dataUrl: layout.dataUrl, fileName: layout.fileName || '' }]
    : []
}

export async function saveFloors(site, floors, actor, summary) {
  await setDoc(layoutRef(site.id), {
    siteId: site.id,
    siteName: site.name,
    floors,
    updatedAt: serverTimestamp(),
    updatedBy: actor?.uid || null,
    updatedByName: actor?.name || '',
  })
  await logAudit(actor, 'erp.layout_save', {
    module: 'emergency', target: 'layout', targetId: site.id, targetLabel: site.name,
    summary: summary || `Updated FERP floor plans for ${site.name} (${floors.length} floor(s))`,
  })
}

export async function deleteLayout(site, actor) {
  await deleteDoc(layoutRef(site.id))
  await logAudit(actor, 'erp.layout_delete', {
    module: 'emergency', target: 'layout', targetId: site.id, targetLabel: site.name,
    summary: `Removed all FERP floor plans for ${site.name}`,
  })
}

// ── Emergency rescue plans (per site, per scenario) ─────────────────────────
const planCol = () => collection(db, 'erpRescuePlans')
const planRef = (id) => doc(db, 'erpRescuePlans', id)

/** Scenarios a site plans a rescue response for. */
export const RESCUE_SCENARIOS = [
  'Fire / Explosion',
  'Vehicle Fire',
  'Medical Emergency',
  'Blood / Body Fluid Spill',
  'Fatality / Serious Injury',
  'Chemical Spill / Release',
  'Gas Leak',
  'Electrical Incident',
  'Confined Space Rescue',
  'Work at Height Rescue',
  'Machine Entrapment',
  'Water / Drowning Rescue',
  'Structural Collapse',
  'Severe Weather / Cyclone',
  'Natural Disaster',
  'Power Outage / Shelter in Place',
  'Water Outage',
  'Suspicious Package',
  'Security Threat',
  'Other',
]

// Site plans are controlled documents: recalled from baseline → adapted →
// approved. Only 'approved' plans are live for site use.
export const PLAN_STATUS = [
  { key: 'draft', label: 'Awaiting approval', tone: 'amber' },
  { key: 'approved', label: 'Approved — in use', tone: 'green' },
  { key: 'review_due', label: 'Review due', tone: 'amber' },
]

export function subscribeRescuePlans(cb) {
  const q = query(planCol(), orderBy('scenario'), limit(COLLECTION_READ_CAP))
  return onSnapshot(q, (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))), () => cb([]))
}

const cleanPlan = (data) => ({
  // 'baseline' = org-wide template plan; 'site' = a site's own plan (often
  // recalled from a baseline and then adapted).
  kind: data.kind === 'baseline' ? 'baseline' : 'site',
  baselineId: data.baselineId || '',
  baselineName: data.baselineName || '',
  customized: !!data.customized,
  // Revision tracking, so a site can tell that its copy has fallen behind.
  // `revision` counts edits to a BASELINE; a site copy records the revision it
  // was taken from in `baselineRevision`. Site plans are derived documents —
  // without this they silently keep whatever the baseline said on the day they
  // were recalled, which is how an obsolete procedure ends up on a wall.
  revision: Number(data.revision) || 0,
  baselineRevision: Number(data.baselineRevision) || 0,
  approvedBy: data.approvedBy || '',
  approvedByName: data.approvedByName || '',
  approvedOn: data.approvedOn || '',
  siteId: data.siteId || '',
  siteName: data.siteName || '',
  region: data.region || '',
  entity: data.entity || '',
  scenario: data.scenario || 'Other',
  title: (data.title || '').trim(),
  description: (data.description || '').trim(),
  triggers: (data.triggers || '').trim(),
  assemblyPoint: (data.assemblyPoint || '').trim(),
  steps: (Array.isArray(data.steps) ? data.steps : [])
    .filter((s) => (s.action || '').trim())
    .map((s, i) => ({
      id: s.id || `st-${i}`,
      order: i + 1,
      action: s.action.trim(),
      responsible: (s.responsible || '').trim(),
    })),
  team: (Array.isArray(data.team) ? data.team : [])
    .filter((t) => (t.name || '').trim() || (t.role || '').trim())
    .map((t, i) => ({
      id: t.id || `tm-${i}`,
      role: (t.role || '').trim(),
      name: (t.name || '').trim(),
      phone: (t.phone || '').trim(),
      uid: t.uid || '',
    })),
  equipment: (Array.isArray(data.equipment) ? data.equipment : []).filter(Boolean),
  status: data.status || 'draft',
  reviewedOn: data.reviewedOn || '',
  nextReviewOn: data.nextReviewOn || '',
})

export async function addRescuePlan(data, actor) {
  const r = await addDoc(planCol(), {
    ...cleanPlan(data), docId: await reserveDocId('emergency'), createdAt: serverTimestamp(), createdBy: actor?.uid || null, createdByName: actor?.name || '',
  })
  await logAudit(actor, 'erp.plan_create', {
    module: 'emergency', target: 'rescuePlan', targetId: r.id, targetLabel: `${data.siteName} · ${data.scenario}`,
    summary: `Created rescue plan "${data.title}" (${data.scenario}) for ${data.siteName}`,
  })
  return r.id
}

export async function updateRescuePlan(id, data, actor) {
  // Editing a baseline bumps its revision, which is what tells every site that
  // recalled it that their copy is now behind.
  const bumped = data.kind === 'baseline'
    ? { ...data, revision: (Number(data.revision) || 0) + 1 }
    : data
  await updateDoc(planRef(id), { ...cleanPlan(bumped), updatedAt: serverTimestamp() })
  await logAudit(actor, 'erp.plan_update', {
    module: 'emergency', target: 'rescuePlan', targetId: id, targetLabel: `${data.siteName} · ${data.scenario}`,
    summary: `Updated rescue plan "${data.title}" for ${data.siteName}`,
  })
}

/**
 * Copy baseline plans onto a site. Each copy keeps a link back to its baseline
 * (`baselineId`) so the site can see where it came from; edits afterwards are
 * local to the site and flag it as customized. Skips scenarios the site already
 * covers. Returns { copied, skipped }.
 */
export async function recallBaselines(site, baselines, existingSitePlans, actor, contacts = []) {
  const covered = new Set(existingSitePlans.filter((p) => p.siteId === site.id).map((p) => p.scenario))
  const targets = baselines.filter((b) => !covered.has(b.scenario))

  // Resolve the baseline's role-only responders against THIS site's internal
  // emergency contacts, so a recalled plan arrives with real names and numbers.
  const internal = contacts.filter((c) => c.kind === 'internal' && (!c.siteId || c.siteId === site.id))
  const contactFor = (role) => internal.find((c) => (c.role || '').toLowerCase() === (role || '').toLowerCase())
  const resolveTeam = (team = []) =>
    team.map((t) => {
      const c = t.name ? null : contactFor(t.role)
      return c ? { ...t, name: c.name, phone: c.phone || t.phone, uid: c.employeeUid || t.uid } : t
    })

  if (targets.length) {
    const batch = writeBatch(db)
    for (const b of targets) {
      batch.set(doc(planCol()), {
        ...cleanPlan({
          ...b,
          kind: 'site',
          baselineId: b.id,
          baselineName: b.title,
          customized: false,
          baselineRevision: Number(b.revision) || 0,
          // Recalled plans always land unapproved — adapt locally, then approve.
          status: 'draft',
          approvedBy: '', approvedByName: '', approvedOn: '',
          team: resolveTeam(b.team),
          siteId: site.id,
          siteName: site.name,
          region: site.region || '',
          entity: site.entity || '',
        }),
        createdAt: serverTimestamp(),
        createdBy: actor?.uid || null,
        createdByName: actor?.name || '',
      })
    }
    await batch.commit()
    await logAudit(actor, 'erp.plan_recall', {
      module: 'emergency', target: 'rescuePlan', targetId: site.id, targetLabel: site.name,
      summary: `Recalled ${targets.length} baseline rescue plan(s) to ${site.name}`,
    })
  }
  return { copied: targets.length, skipped: baselines.length - targets.length }
}

/**
 * Shape one library entry as a storable baseline plan. Pure, so the install
 * preview can show exactly what will be written before anything is.
 */
export function baselinePlanFrom(entry) {
  const today = todayISO()
  return cleanPlan({
    kind: 'baseline',
    scenario: entry.scenario,
    title: entry.title,
    description: entry.description,
    triggers: entry.triggers,
    assemblyPoint: 'Primary Assembly Point (confirm per site)',
    steps: entry.steps.map((s, i) => ({ id: `st-${i}`, order: i + 1, action: s.action, responsible: s.responsible })),
    team: (entry.team || []).map((role, i) => ({ id: `tm-${i}`, role, name: '', phone: '', uid: '' })),
    equipment: entry.equipment || [],
    // Baselines are the org's approved templates; sites still approve their own copies.
    status: 'approved',
    reviewedOn: today,
    nextReviewOn: addDaysISO(365, today),
    revision: 1,
  })
}

/**
 * Decide what installing the library would change. Pure, so the behaviour that
 * matters — never duplicating a scenario, never overwriting without being asked
 * — is testable without writing to a real organization.
 */
export function planLibraryDiff(library, existingBaselines, replace = false) {
  const byScenario = new Map((existingBaselines || []).map((p) => [p.scenario, p]))
  return {
    byScenario,
    toAdd: library.filter((e) => !byScenario.has(e.scenario)),
    toUpdate: replace ? library.filter((e) => byScenario.has(e.scenario)) : [],
  }
}

/**
 * Install the standard baseline library into this organization.
 *
 * This exists in the app rather than only in a seed script because setting up
 * emergency procedures should not require a developer, a terminal or
 * production credentials.
 *
 * Scenarios already present are skipped, so it is safe to re-run as the library
 * grows. `replace: true` overwrites the existing baseline for each scenario and
 * bumps its revision, which is what tells sites their copies are behind.
 */
export async function installBaselineLibrary(library, existingBaselines, actor, { replace = false } = {}) {
  const { toAdd, toUpdate, byScenario } = planLibraryDiff(library, existingBaselines, replace)

  if (!toAdd.length && !toUpdate.length) return { added: 0, updated: 0 }

  // Chunked to stay inside Firestore's 500-operation batch limit.
  const ops = [
    ...toAdd.map((e) => ({ kind: 'add', entry: e })),
    ...toUpdate.map((e) => ({ kind: 'update', entry: e, existing: byScenario.get(e.scenario) })),
  ]
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db)
    for (const op of ops.slice(i, i + 400)) {
      const data = baselinePlanFrom(op.entry)
      if (op.kind === 'add') {
        batch.set(doc(planCol()), {
          ...data,
          createdAt: serverTimestamp(),
          createdBy: actor?.uid || null,
          createdByName: actor?.name || '',
        })
      } else {
        batch.update(planRef(op.existing.id), {
          ...data,
          revision: (Number(op.existing.revision) || 0) + 1,
          updatedAt: serverTimestamp(),
        })
      }
    }
    await batch.commit()
  }

  await logAudit(actor, 'erp.baseline_install', {
    module: 'emergency', target: 'rescuePlan', targetLabel: 'Baseline library',
    summary: `Installed standard baseline library: ${toAdd.length} added` +
      `${toUpdate.length ? `, ${toUpdate.length} replaced` : ''}`,
  })
  return { added: toAdd.length, updated: toUpdate.length }
}

/**
 * Has the baseline moved on since this site copy was taken?
 * Pure, so the list can flag stale procedures without a read.
 */
export function baselineFor(plan, baselines) {
  return baselines.find((b) => b.id === plan.baselineId) || null
}

export function isBehindBaseline(plan, baselines) {
  if (plan.kind === 'baseline' || !plan.baselineId) return false
  const b = baselineFor(plan, baselines)
  if (!b) return false
  return (Number(b.revision) || 0) > (Number(plan.baselineRevision) || 0)
}

/**
 * Pull a revised baseline back down onto a site plan.
 *
 * Site plans are derived from baselines, so a corrected procedure has to be
 * able to reach the sites using it. The copy keeps its own identity — site
 * scoping, assembly point and resolved team stay put — and always returns to
 * draft, because a changed procedure is a changed controlled document and must
 * be re-approved before it is used or printed.
 *
 * `keepLocalEdits` protects a site that deliberately adapted its copy: the
 * baseline's steps are taken but the local title, description, triggers and
 * assembly point are preserved.
 */
export async function syncFromBaseline(plan, baseline, actor, { keepLocalEdits = false } = {}) {
  const payload = cleanPlan({
    ...plan,
    // Content comes from the baseline…
    steps: baseline.steps,
    equipment: baseline.equipment,
    ...(keepLocalEdits ? null : {
      title: baseline.title,
      description: baseline.description,
      triggers: baseline.triggers,
    }),
    // …identity and local adaptation stay with the site.
    kind: 'site',
    baselineId: baseline.id,
    baselineName: baseline.title,
    baselineRevision: Number(baseline.revision) || 0,
    revision: 0,
    customized: keepLocalEdits,
    assemblyPoint: plan.assemblyPoint,
    team: plan.team,
    status: 'draft',
    approvedBy: '', approvedByName: '', approvedOn: '',
  })
  await updateDoc(planRef(plan.id), { ...payload, updatedAt: serverTimestamp() })
  await logAudit(actor, 'erp.plan_sync', {
    module: 'emergency', target: 'rescuePlan', targetId: plan.id,
    targetLabel: `${plan.siteName} · ${plan.scenario}`,
    summary: `Updated "${plan.title}" at ${plan.siteName} from baseline revision ${baseline.revision || 0}` +
      `${keepLocalEdits ? ' (local wording kept)' : ''} — needs re-approval`,
  })
}

/** Approve a site plan for operational use (managers only, enforced in the UI). */
export async function approveRescuePlan(plan, actor) {
  await updateDoc(planRef(plan.id), {
    status: 'approved',
    approvedBy: actor?.uid || null,
    approvedByName: actor?.name || '',
    approvedOn: todayISO(),
    updatedAt: serverTimestamp(),
  })
  await logAudit(actor, 'erp.plan_approve', {
    module: 'emergency', target: 'rescuePlan', targetId: plan.id, targetLabel: `${plan.siteName} · ${plan.title}`,
    summary: `Approved rescue plan "${plan.title}" (${plan.scenario}) for use at ${plan.siteName}`,
  })
}

export async function deleteRescuePlan(id, actor, label) {
  await deleteDoc(planRef(id))
  await logAudit(actor, 'erp.plan_delete', {
    module: 'emergency', target: 'rescuePlan', targetId: id, targetLabel: label,
    summary: `Deleted rescue plan "${label}"`,
  })
}
