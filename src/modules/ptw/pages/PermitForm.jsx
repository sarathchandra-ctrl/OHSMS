import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ClipboardList, Check, Plus, Trash2, User, Building2, ShieldAlert, HardHat, ListChecks,
  Users as UsersIcon, ArrowRight, Table, Paperclip, Flame, Eye, FileWarning, X,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, Field, Spinner, Modal } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { usePermits } from '../context/PermitContext'
import { createPermit } from '../lib/firestore'
import SiteScopePicker from '../../../shared/org/SiteScopePicker'
import DepartmentSelect from '../../../shared/org/DepartmentSelect'
import { subscribeSites as subscribeOrgSites } from '../../../shared/org/orgData'
import { resolveAccessibleSites } from '../../../shared/auth/access'
import { moduleLevels, SITE_LEVEL_KEY } from '../../../shared/org/scopeConfig'
import {
  WORK_TYPES, HAZARDS, ppeGroupsFor, precautionGroupsFor,
  requiredDocsFor, jsaSuggestionsFor, needsFireWatch, needsConfinedWatcher, missingMandatoryDocs,
} from '../lib/ptwData'
import { fileToDataUrl, formatBytes } from '../lib/files'
import { ROLES } from '../lib/permissions'
import { todayISO } from '../../../shared/lib/dates'

const EMPTY = {
  date: todayISO(),
  time: '09:00',
  typeOfWork: '',
  region: '',
  entity: '',
  siteId: '',
  site: '',
  jobLocation: '',
  jobDescription: '',
  issuingDepartment: '',
  issuedToName: '',
  issuedToPhone: '',
  hazards: [],
  ppe: [],
  precautions: [],
  jsa: [],
  participants: [],
  fireWatchers: [],
  confinedWatcher: { name: '', details: '' },
  assignedEngineer: '',
  assignedOperator: '',
}

function SectionCard({ icon: Icon, title, subtitle, children }) {
  return (
    <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="card p-5 sm:p-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand-50 text-brand-600 shadow-elev-sm">
          <Icon size={18} />
        </div>
        <div>
          <h2 className="text-base font-bold text-ink-900">{title}</h2>
          {subtitle && <p className="text-xs text-ink-500">{subtitle}</p>}
        </div>
      </div>
      {children}
    </motion.section>
  )
}

function ToggleChip({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      className={`chip transition ${active ? 'bg-brand-500 text-white' : 'bg-surface text-ink-600 hover:bg-surface-100'}`}>
      {active && <Check size={13} />}
      {children}
    </button>
  )
}

export default function PermitForm() {
  const navigate = useNavigate()
  const { user, profile, org, isAdmin } = useAuth()
  const { users } = usePermits()
  const [form, setForm] = useState(EMPTY)

  // Shared org sites (permission-filtered) drive the correlated Region · Entity ·
  // Site (+ any custom levels like Location) picker, per the module's granularity.
  const [orgSites, setOrgSites] = useState([])
  useEffect(() => {
    return subscribeOrgSites(setOrgSites)
  }, [])
  const siteInventory = useMemo(
    () => resolveAccessibleSites(profile, orgSites, { isAdmin }),
    [profile, orgSites, isAdmin],
  )
  // The scope levels beyond Region/Entity/Site are treated as the job "location".
  const ptwLevels = useMemo(() => moduleLevels(org, 'ptw'), [org])
  const locationKeys = useMemo(
    () => ptwLevels.filter((l) => l.key !== 'region' && l.key !== 'entity' && l.key !== SITE_LEVEL_KEY).map((l) => l.key),
    [ptwLevels],
  )
  // documents: { [key]: { label, mandatory, fileName, fileType, fileData, size } }
  const [docs, setDocs] = useState({})
  const [extraDocs, setExtraDocs] = useState([]) // ad-hoc: { id, label, ...file }
  const [busy, setBusy] = useState(false)
  const [missingModal, setMissingModal] = useState(null) // { missing:[], submit }
  const extraInputRef = useRef(null)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const engineers = useMemo(() => users.filter((u) => u.status === 'approved' && u.role === ROLES.ENGINEERING), [users])
  const operators = useMemo(() => users.filter((u) => u.status === 'approved' && u.role === ROLES.OPERATIONS), [users])
  const internalUsers = useMemo(() => users.filter((u) => u.status === 'approved'), [users])

  const ppeGroups = useMemo(() => ppeGroupsFor(form.typeOfWork), [form.typeOfWork])
  const precautionGroups = useMemo(() => precautionGroupsFor(form.typeOfWork), [form.typeOfWork])
  const requiredDocs = useMemo(() => requiredDocsFor(form.typeOfWork), [form.typeOfWork])

  // Work type seeds PPE, precautions, JSA rows; resets docs + watchers.
  const onWorkType = (e) => {
    const typeOfWork = e.target.value
    const ppe = ppeGroupsFor(typeOfWork).flatMap((g) => g.items)
    const precautions = precautionGroupsFor(typeOfWork).flatMap((g) => g.items)
    const jsa = jsaSuggestionsFor(typeOfWork)
    setForm((f) => ({ ...f, typeOfWork, ppe, precautions, jsa, fireWatchers: [], confinedWatcher: { name: '', details: '' } }))
    setDocs({})
    setExtraDocs([])
  }

  const toggleIn = (key) => (value) =>
    setForm((f) => ({ ...f, [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value] }))
  const toggleHazard = toggleIn('hazards')
  const togglePpe = toggleIn('ppe')
  const togglePrecaution = toggleIn('precautions')

  // ── JSA rows ──
  const addJsaRow = () => setForm((f) => ({ ...f, jsa: [...f.jsa, { step: '', hazard: '', precaution: '' }] }))
  const updateJsaRow = (i, patch) => setForm((f) => ({ ...f, jsa: f.jsa.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) }))
  const removeJsaRow = (i) => setForm((f) => ({ ...f, jsa: f.jsa.filter((_, idx) => idx !== i) }))

  // ── Participants ──
  const addParticipant = (type) => setForm((f) => ({ ...f, participants: [...f.participants, { type, name: '', company: '', contact: '' }] }))
  const updateParticipant = (i, patch) => setForm((f) => ({ ...f, participants: f.participants.map((p, idx) => (idx === i ? { ...p, ...patch } : p)) }))
  const removeParticipant = (i) => setForm((f) => ({ ...f, participants: f.participants.filter((_, idx) => idx !== i) }))

  // ── Fire watchers ──
  const addFireWatcher = () => setForm((f) => ({ ...f, fireWatchers: [...f.fireWatchers, { name: '', details: '' }] }))
  const updateFireWatcher = (i, patch) => setForm((f) => ({ ...f, fireWatchers: f.fireWatchers.map((w, idx) => (idx === i ? { ...w, ...patch } : w)) }))
  const removeFireWatcher = (i) => setForm((f) => ({ ...f, fireWatchers: f.fireWatchers.filter((_, idx) => idx !== i) }))

  // ── Documents ──
  const pickDoc = (req) => async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const f = await fileToDataUrl(file)
      setDocs((d) => ({ ...d, [req.key]: { label: req.label, mandatory: req.mandatory, fileName: f.name, fileType: f.type, fileData: f.dataUrl, size: f.size } }))
    } catch (err) { toastCaught(err) }
  }
  const removeDoc = (key) => setDocs((d) => { const n = { ...d }; delete n[key]; return n })

  const pickExtraDoc = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const f = await fileToDataUrl(file)
      setExtraDocs((arr) => [...arr, { id: `${f.name}-${arr.length}`, label: f.name, fileName: f.name, fileType: f.type, fileData: f.dataUrl, size: f.size }])
    } catch (err) { toastCaught(err) }
  }
  const removeExtraDoc = (id) => setExtraDocs((arr) => arr.filter((x) => x.id !== id))

  const buildDocuments = () => {
    const fromRequired = Object.entries(docs).map(([key, v]) => ({ key, ...v }))
    const fromExtra = extraDocs.map((d) => ({ key: 'extra', label: d.label, mandatory: false, fileName: d.fileName, fileType: d.fileType, fileData: d.fileData, size: d.size }))
    return [...fromRequired, ...fromExtra]
  }

  const doCreate = async () => {
    setBusy(true)
    try {
      const actor = { uid: user.uid, name: profile?.name || '', orgName: profile?.orgName || '', role: profile?.role }
      const payload = {
        ...form,
        participants: form.participants.filter((p) => p.name.trim()),
        jsa: form.jsa.filter((r) => r.step || r.hazard || r.precaution),
        fireWatchers: needsFireWatch(form.typeOfWork) ? form.fireWatchers.filter((w) => w.name.trim()) : [],
        confinedWatcher: needsConfinedWatcher(form.typeOfWork) && form.confinedWatcher.name.trim() ? form.confinedWatcher : null,
        requiredDocs,
        documents: buildDocuments(),
        assignedEngineer: form.assignedEngineer || null,
        assignedOperator: form.assignedOperator || null,
      }
      const { id, permitNo } = await createPermit(payload, actor)
      toast.success(`Permit ${permitNo} created`)
      navigate(`/permits/${id}`)
    } catch (err) {
      toastCaught(err, 'Could not create permit')
    } finally {
      setBusy(false)
      setMissingModal(null)
    }
  }

  const onSubmit = (e) => {
    e.preventDefault()
    if (!form.typeOfWork) return toast.error('Select the type of work')
    if (siteInventory.length && !form.site) return toast.error('Select the site for this permit')
    if (locationKeys.some((k) => !form[k]))
      return toast.error('Select the location scope for this permit')
    if (!form.jobDescription.trim()) return toast.error('Enter a job description')
    if (!form.issuedToName.trim()) return toast.error('Enter the person the permit is issued to')
    // Hard blocks
    if (form.jsa.filter((r) => r.step.trim() && r.hazard.trim() && r.precaution.trim()).length === 0) {
      return toast.error('Complete at least one Job Safety Analysis row (step, hazard & precaution)')
    }
    if (form.participants.filter((p) => p.name.trim()).length === 0) return toast.error('Add at least one participant')
    if (needsFireWatch(form.typeOfWork) && form.fireWatchers.filter((w) => w.name.trim()).length === 0) {
      return toast.error('Hot work requires at least one fire watcher')
    }
    if (needsConfinedWatcher(form.typeOfWork) && !form.confinedWatcher.name.trim()) {
      return toast.error('Confined space requires a standby watcher / attendant')
    }
    // Warn-but-allow: missing mandatory documents
    const missing = missingMandatoryDocs(requiredDocs, Object.keys(docs))
    if (missing.length) return setMissingModal({ missing })
    doCreate()
  }

  return (
    <div>
      <PageHeader icon={ClipboardList} title="New Permit to Work" subtitle="Raise a permit for approval by Engineering & Operations" tourId="newpermit-header" />

      <form onSubmit={onSubmit} className="space-y-5">
        {/* 1 — Basics */}
        <SectionCard icon={ClipboardList} title="Permit details">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Date *"><input type="date" required className="input" value={form.date} onChange={set('date')} /></Field>
            <Field label="Start time *"><input type="time" required className="input" value={form.time} onChange={set('time')} /></Field>
            <Field label="Type of work *" className="sm:col-span-2">
              <select required className="input" value={form.typeOfWork} onChange={onWorkType}>
                <option value="" disabled>Select type of work…</option>
                {WORK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <div className="sm:col-span-2">
              <span className="label">Site &amp; location scope *</span>
              <SiteScopePicker
                module="ptw"
                sites={siteInventory}
                value={form}
                onChange={(v) => setForm((f) => ({
                  ...f,
                  ...v,
                  // Compose the job location from the granularity levels below Site.
                  jobLocation: locationKeys.map((k) => v[k]).filter(Boolean).join(' · '),
                }))}
              />
              {siteInventory.length === 0 && (
                <p className="mt-1 text-xs text-amber-600">No sites you can access yet — an admin can add sites and grant you access.</p>
              )}
            </div>
            <Field label="Issuing department" className="sm:col-span-2"><DepartmentSelect value={form.issuingDepartment} onChange={set('issuingDepartment')} /></Field>
            <Field label="Job description *" className="sm:col-span-2">
              <textarea required rows={3} className="input" placeholder="Describe the work to be carried out" value={form.jobDescription} onChange={set('jobDescription')} />
            </Field>
            <Field label="Issued to (name) *"><input required className="input" placeholder="Person responsible" value={form.issuedToName} onChange={set('issuedToName')} /></Field>
            <Field label="Issued to (phone)"><input className="input" placeholder="+91 …" value={form.issuedToPhone} onChange={set('issuedToPhone')} /></Field>
          </div>
        </SectionCard>

        {/* 2 — Hazards */}
        <SectionCard icon={ShieldAlert} title="Hazard identification" subtitle="Select all hazards present">
          <div className="flex flex-wrap gap-2">
            {HAZARDS.map((h) => <ToggleChip key={h} active={form.hazards.includes(h)} onClick={() => toggleHazard(h)}>{h}</ToggleChip>)}
          </div>
        </SectionCard>

        {/* 3 — JSA */}
        <SectionCard icon={Table} title="Job Safety Analysis (JSA) *" subtitle={form.typeOfWork ? 'Required — complete at least one row (step, hazard & precaution)' : 'Select a work type to seed suggested steps'}>
          <div className="ring-1 ring-ink-200 overflow-hidden rounded-2xl ">
            <div className="hidden grid-cols-[1fr_1fr_1fr_auto] gap-2 bg-surface-100 px-3 py-2 text-xs font-bold uppercase tracking-wide text-ink-500 sm:grid">
              <span>Activity step</span><span>Hazard during activity</span><span>Precaution</span><span className="w-8" />
            </div>
            <div className="divide-y divide-surface-100 bg-surface">
              {form.jsa.length === 0 && <p className="px-3 py-4 text-sm text-ink-400">No steps yet — add one below.</p>}
              {form.jsa.map((r, i) => (
                <div key={i} className="grid grid-cols-1 gap-2 p-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-center">
                  <textarea rows={2} className="input !py-1.5 text-sm" placeholder="Step" value={r.step} onChange={(e) => updateJsaRow(i, { step: e.target.value })} />
                  <textarea rows={2} className="input !py-1.5 text-sm" placeholder="Hazard" value={r.hazard} onChange={(e) => updateJsaRow(i, { hazard: e.target.value })} />
                  <textarea rows={2} className="input !py-1.5 text-sm" placeholder="Precaution" value={r.precaution} onChange={(e) => updateJsaRow(i, { precaution: e.target.value })} />
                  <button type="button" onClick={() => removeJsaRow(i)} className="justify-self-end rounded-lg p-1.5 text-ink-400 hover:text-red-600"><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
          </div>
          <button type="button" className="btn-ghost mt-3" onClick={addJsaRow}><Plus size={15} /> Add step</button>
        </SectionCard>

        {/* 4 — PPE */}
        <SectionCard icon={HardHat} title="PPE required" subtitle={form.typeOfWork ? 'Seeded from the work type — toggle as needed' : 'Select a work type to load the checklist'}>
          {ppeGroups.map((g) => (
            <div key={g.key} className="mb-4 last:mb-0">
              <p className="label">{g.label}</p>
              <div className="flex flex-wrap gap-2">
                {g.items.map((item) => <ToggleChip key={item} active={form.ppe.includes(item)} onClick={() => togglePpe(item)}>{item}</ToggleChip>)}
              </div>
            </div>
          ))}
        </SectionCard>

        {/* 5 — Precautions */}
        <SectionCard icon={ListChecks} title="Precautions" subtitle={form.typeOfWork ? 'Seeded from the work type — toggle as needed' : 'Select a work type to load the checklist'}>
          {precautionGroups.map((g) => (
            <div key={g.key} className="mb-4 last:mb-0">
              <p className="label">{g.label}</p>
              <div className="flex flex-wrap gap-2">
                {g.items.map((item) => <ToggleChip key={item} active={form.precautions.includes(item)} onClick={() => togglePrecaution(item)}>{item}</ToggleChip>)}
              </div>
            </div>
          ))}
        </SectionCard>

        {/* 6 — Required documents */}
        <SectionCard icon={Paperclip} title="Required documents" subtitle={form.typeOfWork ? 'Attach the documents for this activity (PDF or image, up to 2 MB each)' : 'Select a work type to see required documents'}>
          {requiredDocs.length === 0 ? (
            <p className="text-sm text-ink-400">Select a work type to load its document checklist.</p>
          ) : (
            <div className="space-y-2">
              {requiredDocs.map((req) => {
                const attached = docs[req.key]
                return (
                  <div key={req.key} className="ring-1 ring-ink-200 flex flex-wrap items-center gap-2 rounded-2xl bg-surface-50 p-3 ">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-semibold text-ink-800">
                        {req.label}
                        {req.mandatory && <span className="chip bg-red-50 text-red-600">Mandatory</span>}
                      </p>
                      {attached && <p className="truncate text-xs text-ink-500">{attached.fileName} · {formatBytes(attached.size)}</p>}
                    </div>
                    {attached ? (
                      <button type="button" onClick={() => removeDoc(req.key)} className="btn-ghost"><X size={14} /> Remove</button>
                    ) : (
                      <label className="btn-ghost cursor-pointer">
                        <Paperclip size={14} /> Attach
                        <input type="file" accept="application/pdf,image/*" className="hidden" onChange={pickDoc(req)} />
                      </label>
                    )}
                  </div>
                )
              })}
              {extraDocs.map((d) => (
                <div key={d.id} className="ring-1 ring-ink-200 flex flex-wrap items-center gap-2 rounded-2xl bg-surface-50 p-3 ">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink-800">Other document</p>
                    <p className="truncate text-xs text-ink-500">{d.fileName} · {formatBytes(d.size)}</p>
                  </div>
                  <button type="button" onClick={() => removeExtraDoc(d.id)} className="btn-ghost"><X size={14} /> Remove</button>
                </div>
              ))}
              <button type="button" className="btn-ghost" onClick={() => extraInputRef.current?.click()}><Plus size={15} /> Add other document</button>
              <input ref={extraInputRef} type="file" accept="application/pdf,image/*" className="hidden" onChange={pickExtraDoc} />
            </div>
          )}
        </SectionCard>

        {/* 7 — Fire watchers (hot work) */}
        {needsFireWatch(form.typeOfWork) && (
          <SectionCard icon={Flame} title="Fire watcher(s)" subtitle="Required for hot work — fire watch maintained ≥30 min after completion">
            <div className="space-y-2">
              {form.fireWatchers.map((w, i) => (
                <div key={i} className="grid grid-cols-1 gap-2 rounded-2xl bg-surface p-3  sm:grid-cols-[1fr_1fr_auto] sm:items-center">
                  <input className="input" placeholder="Fire watcher name" value={w.name} onChange={(e) => updateFireWatcher(i, { name: e.target.value })} />
                  <input className="input" placeholder="Details (phone / role)" value={w.details} onChange={(e) => updateFireWatcher(i, { details: e.target.value })} />
                  <button type="button" onClick={() => removeFireWatcher(i)} className="justify-self-end rounded-lg p-1.5 text-ink-400 hover:text-red-600"><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
            <button type="button" className="btn-ghost mt-3" onClick={addFireWatcher}><Plus size={15} /> Add fire watcher</button>
          </SectionCard>
        )}

        {/* 8 — Confined-space watcher */}
        {needsConfinedWatcher(form.typeOfWork) && (
          <SectionCard icon={Eye} title="Standby watcher / attendant" subtitle="Required for confined space — stays outside, maintains comms & raises the alarm">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Watcher name *"><input className="input" placeholder="Attendant name" value={form.confinedWatcher.name} onChange={(e) => setForm((f) => ({ ...f, confinedWatcher: { ...f.confinedWatcher, name: e.target.value } }))} /></Field>
              <Field label="Details"><input className="input" placeholder="Phone / role" value={form.confinedWatcher.details} onChange={(e) => setForm((f) => ({ ...f, confinedWatcher: { ...f.confinedWatcher, details: e.target.value } }))} /></Field>
            </div>
          </SectionCard>
        )}

        {/* 9 — Participants */}
        <SectionCard icon={UsersIcon} title="Participants *" subtitle="At least one participant is required">
          <div className="space-y-3">
            {form.participants.map((p, i) => (
              <div key={i} className="ring-1 ring-ink-200 rounded-2xl bg-surface-50 p-3 ">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex gap-1.5">
                    <button type="button" onClick={() => updateParticipant(i, { type: 'internal', name: '', contact: '' })}
                      className={`chip ${p.type === 'internal' ? 'bg-brand-500 text-white' : 'bg-surface-100 text-ink-600'}`}><User size={13} /> Internal</button>
                    <button type="button" onClick={() => updateParticipant(i, { type: 'external', name: '', contact: '' })}
                      className={`chip ${p.type === 'external' ? 'bg-brand-500 text-white' : 'bg-surface-100 text-ink-600'}`}><Building2 size={13} /> External</button>
                  </div>
                  <button type="button" onClick={() => removeParticipant(i)} className="rounded-lg p-1.5 text-ink-400 hover:text-red-600"><Trash2 size={15} /></button>
                </div>
                {p.type === 'internal' ? (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <select className="input" value={p.name}
                      onChange={(e) => {
                        const u = internalUsers.find((x) => x.name === e.target.value)
                        updateParticipant(i, { name: e.target.value, company: u?.orgName || '', contact: u?.phone || '' })
                      }}>
                      <option value="" disabled>Select teammate…</option>
                      {internalUsers.map((u) => <option key={u.uid} value={u.name}>{u.name}</option>)}
                    </select>
                    <input className="input" placeholder="Contact" value={p.contact} onChange={(e) => updateParticipant(i, { contact: e.target.value })} />
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <input className="input" placeholder="Full name" value={p.name} onChange={(e) => updateParticipant(i, { name: e.target.value })} />
                    <input className="input" placeholder="Company" value={p.company} onChange={(e) => updateParticipant(i, { company: e.target.value })} />
                    <input className="input" placeholder="Contact" value={p.contact} onChange={(e) => updateParticipant(i, { contact: e.target.value })} />
                  </div>
                )}
              </div>
            ))}
            {form.participants.length === 0 && <p className="text-sm text-ink-400">No participants yet — add at least one.</p>}
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn-ghost" onClick={() => addParticipant('internal')}><Plus size={15} /> Internal</button>
            <button type="button" className="btn-ghost" onClick={() => addParticipant('external')}><Plus size={15} /> External</button>
          </div>
        </SectionCard>

        {/* 10 — Assignment */}
        <SectionCard icon={Check} title="Assign approvers (optional)" subtitle="Leave blank to route to the whole team">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Engineering approver" hint={engineers.length ? '' : 'No Engineering users yet — will route to the team'}>
              <select className="input" value={form.assignedEngineer} onChange={set('assignedEngineer')}>
                <option value="">Whole Engineering team</option>
                {engineers.map((u) => <option key={u.uid} value={u.uid}>{u.name}</option>)}
              </select>
            </Field>
            <Field label="Operations approver" hint={operators.length ? '' : 'No Operations users yet — will route to the team'}>
              <select className="input" value={form.assignedOperator} onChange={set('assignedOperator')}>
                <option value="">Whole Operations team</option>
                {operators.map((u) => <option key={u.uid} value={u.uid}>{u.name}</option>)}
              </select>
            </Field>
          </div>
        </SectionCard>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => navigate('/permits')}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? <Spinner size={18} /> : (<>Create permit <ArrowRight size={16} /></>)}
          </button>
        </div>
      </form>

      {/* Missing mandatory documents — warn but allow */}
      <Modal open={!!missingModal} onClose={() => setMissingModal(null)} title="Missing mandatory documents">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-red-50 text-red-600"><FileWarning size={20} /></div>
          <div>
            <p className="text-sm text-ink-600">These mandatory documents have not been attached:</p>
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-ink-800">
              {missingModal?.missing.map((d) => <li key={d.key}>{d.label}</li>)}
            </ul>
            <p className="mt-2 text-xs text-ink-400">You can still create the permit — approvers will see the gap.</p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setMissingModal(null)}>Go back &amp; attach</button>
          <button className="btn-primary" onClick={doCreate} disabled={busy}>{busy ? <Spinner size={18} /> : 'Create anyway'}</button>
        </div>
      </Modal>
    </div>
  )
}
