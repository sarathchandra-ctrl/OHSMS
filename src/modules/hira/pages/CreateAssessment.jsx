import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  FilePlus2, Save, Plus, Trash2, Shield, UserPlus, AlertTriangle,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, Spinner, Field } from '../components/ui'
import { RiskBadge, MiniMatrix } from '../components/RiskBits'
import { useAuth } from '../context/AuthContext'
import { useRa } from '../context/RaContext'
import { createAssessment, updateAssessment, logActivity, subscribeOrgUsers } from '../lib/firestore'
import SiteScopePicker from '../../../shared/org/SiteScopePicker'
import DepartmentSelect from '../../../shared/org/DepartmentSelect'
import DeptPersonPicker from '../../../shared/org/DeptPersonPicker'
import { riskLevel, PROBABILITY, SEVERITY } from '../lib/riskMatrix'
import {
  HAZARD_GROUPS, categoriesForGroup, typesForCategory,
  CONTROL_HIERARCHY, CONTROL_STATUS, MEMBER_TYPES, ACTIVITY_NATURE, ASSESSMENT_STATUS,
} from '../lib/constants'
import { uid } from '../lib/id'

const newControl = () => ({ id: uid('c'), hierarchy: 'Elimination', description: '', responsibleMemberId: '', department: '', status: 'Open', dueDate: '' })
const newHazard = () => ({
  id: uid('h'), description: '', whoMightBeHarmed: '',
  hazardGroup: '', hazardCategory: '', hazardType: '', specificLocation: '',
  probability: '', severity: '',
  controls: [], alarp: false, additionalControls: [],
  projectedProbability: '', projectedSeverity: '',
})
const newActivity = () => ({ id: uid('a'), title: '', nature: 'Routine', hazards: [newHazard()] })
const newMember = (type = 'internal') => ({ id: uid('m'), name: '', email: '', role: '', department: '', type })

// Short human reference id, e.g. HIRA-HYD8-3F9A2C
const genRefId = (site) => {
  const slug = (site || 'SITE').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 6) || 'SITE'
  const rand = uid('').replace(/-/g, '').slice(0, 6).toUpperCase()
  return `HIRA-${slug}-${rand}`
}

const emptyForm = () => ({
  name: '', siteName: '', region: '', entity: '', siteId: '',
  location: '', assessmentDate: '', status: 'ACTIVE', refId: '',
  kind: 'site', baselineId: '',
  members: [], activities: [newActivity()],
})

// Deep-copy a baseline's activities into fresh rows (new ids) for a site RA.
const copyActivities = (activities) =>
  (activities?.length ? activities : [newActivity()]).map((act) => ({
    id: uid('a'),
    title: act.title || '',
    nature: act.nature || 'Routine',
    hazards: (act.hazards?.length ? act.hazards : [newHazard()]).map((h) => ({
      ...newHazard(),
      ...h,
      id: uid('h'),
      controls: (h.controls || []).map((c) => ({ ...c, id: uid('c') })),
      additionalControls: (h.additionalControls || []).map((c) => ({ ...c, id: uid('c') })),
    })),
  }))

function Section({ n, title, subtitle, children }) {
  return (
    <div className="card mb-5 p-6">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand-500 text-sm font-bold text-white shadow-glow">{n}</span>
        <div>
          <h2 className="text-lg font-extrabold text-ink-900">{title}</h2>
          {subtitle && <p className="text-xs text-ink-400">{subtitle}</p>}
        </div>
      </div>
      {children}
    </div>
  )
}

export default function CreateAssessment() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { profile, user } = useAuth()
  const { assessments, org, siteInventory } = useRa()
  const [form, setForm] = useState(emptyForm)
  const [busy, setBusy] = useState(false)
  const [loadedId, setLoadedId] = useState(null)

  // Employee directory for the internal-member Department → Person drill-down.
  const [orgUsers, setOrgUsers] = useState([])
  useEffect(() => {
    return subscribeOrgUsers(setOrgUsers)
  }, [])

  // Edit mode: hydrate form from the existing assessment once it's available.
  useEffect(() => {
    if (!id || loadedId === id) return
    const a = assessments.find((x) => x.id === id)
    if (a) {
      setForm({
        name: a.name || '', siteName: a.siteName || '', region: a.region || '', entity: a.entity || '', siteId: a.siteId || '',
        location: a.location || '', assessmentDate: a.assessmentDate || '',
        status: a.status || 'ACTIVE', refId: a.refId || '',
        kind: a.kind || 'site', baselineId: a.baselineId || '',
        members: a.members || [],
        activities: (a.activities?.length ? a.activities : [newActivity()]).map((act) => ({
          id: act.id || uid('a'), title: act.title || '', nature: act.nature || 'Routine',
          hazards: (act.hazards?.length ? act.hazards : [newHazard()]).map((h) => ({ ...newHazard(), ...h })),
        })),
      })
      setLoadedId(id)
    }
  }, [id, assessments, loadedId])

  // New-assessment initialization from query params:
  //   ?kind=baseline           → create a baseline (activity template, no site)
  //   ?from=<baselineId>       → seed a site RA from a baseline (then edit)
  const [searchParams] = useSearchParams()
  const kindParam = searchParams.get('kind')
  const fromId = searchParams.get('from')
  const [paramsInited, setParamsInited] = useState(false)
  useEffect(() => {
    if (id || paramsInited) return
    if (fromId) {
      const base = assessments.find((x) => x.id === fromId)
      if (!base) return // wait for assessments to load
      setForm((f) => ({
        ...f,
        kind: 'site',
        baselineId: fromId,
        name: base.name ? `${base.name} — site assessment` : '',
        members: base.members || [],
        activities: copyActivities(base.activities),
      }))
      setParamsInited(true)
    } else if (kindParam === 'baseline') {
      setForm((f) => ({ ...f, kind: 'baseline' }))
      setParamsInited(true)
    } else {
      setParamsInited(true)
    }
  }, [id, fromId, kindParam, assessments, paramsInited])

  const internalMembers = useMemo(() => form.members.filter((m) => m.type === 'internal' && m.name.trim()), [form.members])

  // ── State helpers ───────────────────────────────────────────────────────────
  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const updateActivities = (fn) => setForm((f) => ({ ...f, activities: fn(f.activities) }))
  const mapActivity = (aid, fn) => updateActivities((acts) => acts.map((a) => (a.id === aid ? fn(a) : a)))
  const mapHazard = (aid, hid, fn) => mapActivity(aid, (a) => ({ ...a, hazards: a.hazards.map((h) => (h.id === hid ? fn(h) : h)) }))

  const addMember = (type) => setForm((f) => ({ ...f, members: [...f.members, newMember(type)] }))
  const updateMember = (mid, patch) => setForm((f) => ({ ...f, members: f.members.map((m) => (m.id === mid ? { ...m, ...patch } : m)) }))
  const removeMember = (mid) => setForm((f) => ({ ...f, members: f.members.filter((m) => m.id !== mid) }))

  const addActivity = () => updateActivities((acts) => [...acts, newActivity()])
  const removeActivity = (aid) => updateActivities((acts) => acts.filter((a) => a.id !== aid))
  const addHazard = (aid) => mapActivity(aid, (a) => ({ ...a, hazards: [...a.hazards, newHazard()] }))
  const updateHazard = (aid, hid, patch) => mapHazard(aid, hid, (h) => ({ ...h, ...patch }))
  const removeHazard = (aid, hid) => mapActivity(aid, (a) => ({ ...a, hazards: a.hazards.filter((h) => h.id !== hid) }))

  const addControl = (aid, hid, kind) => mapHazard(aid, hid, (h) => ({ ...h, [kind]: [...h[kind], newControl()] }))
  const updateControl = (aid, hid, kind, cid, patch) => mapHazard(aid, hid, (h) => ({ ...h, [kind]: h[kind].map((c) => (c.id === cid ? { ...c, ...patch } : c)) }))
  const removeControl = (aid, hid, kind, cid) => mapHazard(aid, hid, (h) => ({ ...h, [kind]: h[kind].filter((c) => c.id !== cid) }))

  // ── Submit ──────────────────────────────────────────────────────────────────
  const onSubmit = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) return toast.error('Name of Risk Assessment is required')
    if (!form.activities.length) return toast.error('Add at least one activity')

    // Normalise: coerce numeric P/S, drop additional controls/projected when ALARP.
    const payload = {
      name: form.name.trim(),
      kind: form.kind || 'site',
      baselineId: form.baselineId || '',
      siteName: form.siteName.trim(),
      region: form.region || '',
      entity: form.entity || '',
      siteId: form.siteId || '',
      location: form.location.trim(),
      assessmentDate: form.assessmentDate,
      status: form.status || 'ACTIVE',
      refId: form.refId || genRefId(form.siteName),
      members: form.members.filter((m) => m.name.trim()),
      activities: form.activities.map((a) => ({
        id: a.id,
        title: a.title.trim(),
        nature: a.nature || 'Routine',
        // ALARP means the residual risk is ACCEPTED as it stands: no further
        // controls are planned, so there is no projected reduction to record.
        // The comment above this block has always said the two are dropped and
        // no branch ever did it — so an ALARP hazard kept its projected P×S,
        // and the register showed a LOWER residual risk for exactly the hazards
        // somebody had decided to live with, which is the opposite of what
        // accepting a risk is supposed to make visible. The CSV importer
        // (lib/csv.js) has always dropped them, so the two paths produced
        // different data from the same decision.
        //
        // residualRisk() now ignores a projected score on an ALARP hazard too.
        // This is still the right place for the rule — a contradiction is
        // better not stored than reasoned around — but it cannot reach the
        // assessments saved before it, which is why the read side checks as
        // well.
        hazards: a.hazards.map((h) => ({
          ...h,
          probability: Number(h.probability) || null,
          severity: Number(h.severity) || null,
          additionalControls: h.alarp ? [] : h.additionalControls,
          projectedProbability: h.alarp ? null : Number(h.projectedProbability) || null,
          projectedSeverity: h.alarp ? null : Number(h.projectedSeverity) || null,
        })),
      })),
    }

    setBusy(true)
    try {
      const actor = { uid: user?.uid, name: profile?.name }
      let savedId = id
      if (id) {
        await updateAssessment(id, payload)
        toast.success('Assessment updated')
      } else {
        savedId = await createAssessment(payload, actor)
        toast.success('Assessment created')
      }
      logActivity(actor, {
        type: id ? 'updated' : 'created',
        message: `${id ? 'updated' : 'created'} risk assessment “${payload.name}”`,
        assessmentId: savedId,
      })
      navigate('/hira/repository')
    } catch (err) {
      toastCaught(err, 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <PageHeader
        tour="create-header"
        title={
          form.kind === 'baseline'
            ? (id ? 'Edit Baseline Risk Assessment' : 'Create Baseline Risk Assessment')
            : (id ? 'Edit Risk Assessment' : 'Create Risk Assessment')
        }
        subtitle={
          form.kind === 'baseline'
            ? 'Activity-level template — reusable across sites'
            : 'Hazard identification & risk assessment (HIRA)'
        }
        icon={FilePlus2}
      >
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? <Spinner size={18} /> : (<><Save size={16} /> {id ? 'Save changes' : 'Save assessment'}</>)}
        </button>
      </PageHeader>

      {/* ── Section 1: Details ── */}
      <Section n={1} title="Assessment details">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Name of Risk Assessment *" className="lg:col-span-2">
            <input className="input" placeholder="e.g. Loading Dock Operations" value={form.name} onChange={(e) => setField('name', e.target.value)} />
          </Field>
          {form.kind === 'baseline' ? (
            <div className="lg:col-span-2">
              <div className="rounded-2xl bg-brand-50 px-4 py-3 text-sm text-brand-800">
                This is a <b>baseline</b> (activity-level template). It isn&apos;t tied to a site — create
                site assessments from it in the <b>Baselines</b> tab.
              </div>
            </div>
          ) : (
            <div className="lg:col-span-2">
              {/* A heading, not a <label>: SiteScopePicker renders three selects
                  and names each one itself, so there is no single control for
                  this to point at. A <label> that labels nothing is worse than
                  none — it is announced as a name with no owner. */}
              <span className="label">Facility / Site — Region · Entity · Site</span>
              <SiteScopePicker
                module="hira"
                sites={siteInventory}
                value={{ ...form, site: form.siteName }}
                onChange={(v) => setForm((f) => ({ ...f, ...v, siteName: v.site }))}
              />
              {form.baselineId && (
                <p className="mt-1 text-xs text-brand-700">
                  Seeded from a baseline — edit below to add site-specific risks or controls.
                </p>
              )}
            </div>
          )}
          <Field label="Risk Assessment Date">
            <input type="date" className="input" value={form.assessmentDate} onChange={(e) => setField('assessmentDate', e.target.value)} />
          </Field>
          {/* htmlFor is explicit here because the <datalist> is a second child,
              so Field cannot tell which element the label means. */}
          <Field label="Location" htmlFor="ra-location" className="lg:col-span-2">
            <input id="ra-location" className="input" list="org-locations" placeholder="e.g. Inbound Dock" value={form.location} onChange={(e) => setField('location', e.target.value)} />
            <datalist id="org-locations">
              {(org?.locations || []).map((l) => <option key={l} value={l}>{l}</option>)}
            </datalist>
          </Field>
          <Field label="Status">
            <select className="input" value={form.status} onChange={(e) => setField('status', e.target.value)}>
              {ASSESSMENT_STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          {form.refId && (
            <Field label="Reference ID">
              <input className="input bg-surface-100 text-ink-500" value={form.refId} readOnly />
            </Field>
          )}
        </div>
      </Section>

      {/* ── Section 2: Members ── */}
      <Section n={2} title="Members involved" subtitle="Add internal and external members. Internal members can be assigned as responsible persons for controls.">
        <div className="space-y-2">
          <AnimatePresence initial={false}>
            {form.members.map((m) => (
              <motion.div key={m.id} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="grid items-end gap-2 rounded-2xl bg-canvas/40 p-3  sm:grid-cols-12">
                {m.type === 'internal' && (
                  <Field label="Pick from employee directory — Department · Person" className="sm:col-span-12">
                    <DeptPersonPicker
                      users={orgUsers.filter((u) => u.status === 'approved')}
                      value={m.uid || ''}
                      onChange={(v, u) =>
                        updateMember(m.id, {
                          uid: v,
                          name: u?.name || m.name,
                          email: u?.email || m.email,
                          department: u?.department || u?.dept || m.department,
                        })
                      }
                      personPlaceholder="Select employee…"
                    />
                  </Field>
                )}
                <Field label="Type" className="sm:col-span-2">
                  <select className="input" value={m.type} onChange={(e) => updateMember(m.id, { type: e.target.value })}>
                    {MEMBER_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </select>
                </Field>
                <Field label="Name" className="sm:col-span-3">
                  <input className="input" placeholder="Full name" value={m.name} onChange={(e) => updateMember(m.id, { name: e.target.value })} />
                </Field>
                <Field label="Email" className="sm:col-span-3">
                  <input className="input" placeholder="email@company.com" value={m.email} onChange={(e) => updateMember(m.id, { email: e.target.value })} />
                </Field>
                <Field label="Role" className="sm:col-span-2">
                  <input className="input" placeholder="Role" value={m.role} onChange={(e) => updateMember(m.id, { role: e.target.value })} />
                </Field>
                <div className="sm:col-span-2 flex items-end gap-2">
                  <Field label="Department" className="flex-1">
                    <DepartmentSelect value={m.department} onChange={(e) => updateMember(m.id, { department: e.target.value })} />
                  </Field>
                  <button type="button" onClick={() => removeMember(m.id)} className="mb-0.5 rounded-xl p-2.5 text-red-500 shadow-elev-sm transition hover:bg-red-50" title="Remove"><Trash2 size={16} /></button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {form.members.length === 0 && <p className="px-1 text-sm text-ink-400">No members added yet.</p>}
        </div>
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn-soft" onClick={() => addMember('internal')}><Shield size={16} /> Add internal</button>
          <button type="button" className="btn-ghost" onClick={() => addMember('external')}><UserPlus size={16} /> Add external</button>
        </div>
      </Section>

      {/* ── Section 3: Activities & hazards ── */}
      <Section n={3} title="Activities & hazards" subtitle="Add tasks/processes, then identify hazards, score risk and apply controls.">
        <div className="space-y-4">
          {form.activities.map((a, ai) => (
            <ActivityCard
              key={a.id}
              activity={a}
              index={ai}
              internalMembers={internalMembers}
              canRemove={form.activities.length > 1}
              onTitle={(v) => mapActivity(a.id, (act) => ({ ...act, title: v }))}
              onNature={(v) => mapActivity(a.id, (act) => ({ ...act, nature: v }))}
              onRemove={() => removeActivity(a.id)}
              onAddHazard={() => addHazard(a.id)}
              onUpdateHazard={(hid, patch) => updateHazard(a.id, hid, patch)}
              onRemoveHazard={(hid) => removeHazard(a.id, hid)}
              onAddControl={(hid, kind) => addControl(a.id, hid, kind)}
              onUpdateControl={(hid, kind, cid, patch) => updateControl(a.id, hid, kind, cid, patch)}
              onRemoveControl={(hid, kind, cid) => removeControl(a.id, hid, kind, cid)}
            />
          ))}
        </div>
        <button type="button" className="btn-soft mt-4" onClick={addActivity}><Plus size={16} /> Add activity / task</button>
      </Section>

      <div className="flex justify-end">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? <Spinner size={18} /> : (<><Save size={16} /> {id ? 'Save changes' : 'Save assessment'}</>)}
        </button>
      </div>
    </form>
  )
}

// ── Activity card ──────────────────────────────────────────────────────────────
function ActivityCard({ activity, index, internalMembers, canRemove, onTitle, onNature, onRemove, onAddHazard, onUpdateHazard, onRemoveHazard, onAddControl, onUpdateControl, onRemoveControl }) {
  return (
    <div className="rounded-2xl border border-surface-200 bg-surface/60 p-4">
      <div className="mb-3 flex items-end gap-2">
        <span className="mb-2.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-magenta-500 text-xs font-bold text-white">{index + 1}</span>
        <Field label="Activity / Task / Process" className="flex-1">
          <input className="input" placeholder="e.g. Unloading trailers" value={activity.title} onChange={(e) => onTitle(e.target.value)} />
        </Field>
        <Field label="Nature" className="w-40">
          <select className="input" value={activity.nature || 'Routine'} onChange={(e) => onNature(e.target.value)}>
            {ACTIVITY_NATURE.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        {canRemove && (
          <button type="button" onClick={onRemove} className="mb-0.5 rounded-xl p-2.5 text-red-500 shadow-elev-sm transition hover:bg-red-50" title="Remove activity"><Trash2 size={16} /></button>
        )}
      </div>

      <div className="space-y-3">
        {activity.hazards.map((h, hi) => (
          <HazardCard
            key={h.id}
            hazard={h}
            index={hi}
            internalMembers={internalMembers}
            canRemove={activity.hazards.length > 1}
            onUpdate={(patch) => onUpdateHazard(h.id, patch)}
            onRemove={() => onRemoveHazard(h.id)}
            onAddControl={(kind) => onAddControl(h.id, kind)}
            onUpdateControl={(kind, cid, patch) => onUpdateControl(h.id, kind, cid, patch)}
            onRemoveControl={(kind, cid) => onRemoveControl(h.id, kind, cid)}
          />
        ))}
      </div>
      <button type="button" className="btn-ghost mt-3 text-sm" onClick={onAddHazard}><Plus size={15} /> Add hazard</button>
    </div>
  )
}

// ── Hazard card ────────────────────────────────────────────────────────────────
function HazardCard({ hazard: h, index, internalMembers, canRemove, onUpdate, onRemove, onAddControl, onUpdateControl, onRemoveControl }) {
  const categories = categoriesForGroup(h.hazardGroup)
  const types = typesForCategory(h.hazardCategory)
  const initial = riskLevel(h.probability, h.severity)
  const projected = riskLevel(h.projectedProbability, h.projectedSeverity)

  return (
    <div className="ring-1 ring-ink-200 rounded-2xl bg-canvas/50 p-4 ">
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-bold text-ink-700">
          <AlertTriangle size={15} className="text-brand-500" /> Hazard {index + 1}
        </span>
        {canRemove && (
          <button type="button" onClick={onRemove} className="rounded-lg p-2 text-red-500 shadow-elev-sm transition hover:bg-red-50" title="Remove hazard"><Trash2 size={15} /></button>
        )}
      </div>

      {/* Cascading group → category → type */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Hazard Group">
          <select className="input" value={h.hazardGroup} onChange={(e) => onUpdate({ hazardGroup: e.target.value, hazardCategory: '', hazardType: '' })}>
            <option value="">Select group…</option>
            {HAZARD_GROUPS.map((g) => <option key={g}>{g}</option>)}
          </select>
        </Field>
        <Field label="Hazard Category">
          <select className="input" value={h.hazardCategory} disabled={!h.hazardGroup} onChange={(e) => onUpdate({ hazardCategory: e.target.value, hazardType: '' })}>
            <option value="">{h.hazardGroup ? 'Select category…' : 'Pick a group first'}</option>
            {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Hazard Type">
          <select className="input" value={h.hazardType} disabled={!h.hazardCategory} onChange={(e) => onUpdate({ hazardType: e.target.value })}>
            <option value="">{h.hazardCategory ? 'Select type…' : 'Pick a category first'}</option>
            {types.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Who might be harmed">
          <input className="input" placeholder="e.g. Dock associates, visitors" value={h.whoMightBeHarmed} onChange={(e) => onUpdate({ whoMightBeHarmed: e.target.value })} />
        </Field>
        <Field label="Specific location">
          <input className="input" placeholder="e.g. Dock door 12" value={h.specificLocation} onChange={(e) => onUpdate({ specificLocation: e.target.value })} />
        </Field>
      </div>

      <Field label="Hazard description (optional)" className="mt-3">
        <input className="input" placeholder="Describe the hazard / how harm occurs" value={h.description} onChange={(e) => onUpdate({ description: e.target.value })} />
      </Field>

      {/* Risk scoring */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_auto]">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Probability">
            <select className="input" value={h.probability} onChange={(e) => onUpdate({ probability: e.target.value })}>
              <option value="">Select…</option>
              {PROBABILITY.map((p) => <option key={p.value} value={p.value}>{p.value} — {p.label}</option>)}
            </select>
          </Field>
          <Field label="Severity">
            <select className="input" value={h.severity} onChange={(e) => onUpdate({ severity: e.target.value })}>
              <option value="">Select…</option>
              {SEVERITY.map((s) => <option key={s.value} value={s.value}>{s.value} — {s.label}</option>)}
            </select>
          </Field>
          <div className="sm:col-span-2 flex items-center gap-3">
            <span className="text-sm font-semibold text-ink-600">Risk level:</span>
            <RiskBadge risk={initial} />
            {initial && <span className="text-xs text-ink-400">{initial.guidance}</span>}
          </div>
        </div>
        <div className="flex items-center justify-center rounded-2xl bg-surface p-3 shadow-elev-sm">
          <MiniMatrix probability={h.probability} severity={h.severity} />
        </div>
      </div>

      {/* Control measures */}
      <ControlBlock
        title="Control measures"
        controls={h.controls}
        internalMembers={internalMembers}
        onAdd={() => onAddControl('controls')}
        onUpdate={(cid, patch) => onUpdateControl('controls', cid, patch)}
        onRemove={(cid) => onRemoveControl('controls', cid)}
      />

      {/* Additional controls — always available */}
      <ControlBlock
        title="Additional control measures"
        controls={h.additionalControls}
        internalMembers={internalMembers}
        showDueDate
        onAdd={() => onAddControl('additionalControls')}
        onUpdate={(cid, patch) => onUpdateControl('additionalControls', cid, patch)}
        onRemove={(cid) => onRemoveControl('additionalControls', cid)}
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Projected Probability">
          <select className="input" value={h.projectedProbability} onChange={(e) => onUpdate({ projectedProbability: e.target.value })}>
            <option value="">Select…</option>
            {PROBABILITY.map((p) => <option key={p.value} value={p.value}>{p.value} — {p.label}</option>)}
          </select>
        </Field>
        <Field label="Projected Severity">
          <select className="input" value={h.projectedSeverity} onChange={(e) => onUpdate({ projectedSeverity: e.target.value })}>
            <option value="">Select…</option>
            {SEVERITY.map((s) => <option key={s.value} value={s.value}>{s.value} — {s.label}</option>)}
          </select>
        </Field>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-ink-600">Projected (residual) risk:</span>
          <RiskBadge risk={projected} />
        </div>
      </div>

      {/* ALARP acceptance flag — residual risk accepted */}
      <label className="mt-4 flex items-center gap-2.5 rounded-2xl bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-800">
        <input type="checkbox" className="h-4 w-4 accent-amber-600" checked={h.alarp} onChange={(e) => onUpdate({ alarp: e.target.checked })} />
        Residual risk accepted as ALARP (as low as reasonably practicable)
      </label>
    </div>
  )
}

// ── Reusable control list ───────────────────────────────────────────────────────
function ControlBlock({ title, controls, internalMembers, onAdd, onUpdate, onRemove, showDueDate = false }) {
  return (
    <div className="mt-4">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-500">{title}</p>
      <div className="space-y-2">
        {controls.map((c) => (
          <div key={c.id} className="grid items-end gap-2 rounded-xl bg-surface p-2.5 shadow-elev-sm sm:grid-cols-12">
            <Field label="Hierarchy" className="sm:col-span-3">
              <select className="input" value={c.hierarchy} onChange={(e) => onUpdate(c.id, { hierarchy: e.target.value })}>
                {CONTROL_HIERARCHY.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
            </Field>
            <Field label="Control description" className="sm:col-span-4">
              <input className="input" placeholder="Describe the control" value={c.description} onChange={(e) => onUpdate(c.id, { description: e.target.value })} />
            </Field>
            <Field label="Responsible (internal)" className="sm:col-span-2">
              <select className="input" value={c.responsibleMemberId} onChange={(e) => onUpdate(c.id, { responsibleMemberId: e.target.value })}>
                <option value="">—</option>
                {internalMembers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Field>
            <Field label="Status" className="sm:col-span-2">
              <select className="input" value={c.status} onChange={(e) => onUpdate(c.id, { status: e.target.value })}>
                {CONTROL_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </Field>
            <div className="sm:col-span-1 flex items-end">
              <button type="button" onClick={() => onRemove(c.id)} className="mb-0.5 rounded-xl p-2.5 text-red-500 shadow-elev-sm transition hover:bg-red-50" title="Remove control"><Trash2 size={15} /></button>
            </div>
            <Field label="Department" className="sm:col-span-3">
              <DepartmentSelect value={c.department} onChange={(e) => onUpdate(c.id, { department: e.target.value })} />
            </Field>
            {showDueDate && (
              <Field label="Due date" className="sm:col-span-3">
                <input type="date" className="input" value={c.dueDate || ''} onChange={(e) => onUpdate(c.id, { dueDate: e.target.value })} />
              </Field>
            )}
          </div>
        ))}
        {controls.length === 0 && <p className="px-1 text-xs text-ink-400">No controls added.</p>}
      </div>
      <button type="button" className="btn-ghost mt-2 px-3 py-1.5 text-xs" onClick={onAdd}><Plus size={14} /> Add control</button>
    </div>
  )
}
